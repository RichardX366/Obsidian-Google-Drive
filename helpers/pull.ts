import type ObsidianGoogleDrive from '../main';
import { Notice, TFile, TFolder } from 'obsidian';
import {
	batchAsync,
	FileMetadata,
	folderMimeType,
	foldersToBatches,
	getSyncMessage,
	unSplitPath,
} from './drive';
import { refreshAccessToken } from './requests';

export const pull = async (t: ObsidianGoogleDrive, silenceNotices = false) => {
	let syncNotice = undefined;

	if (!silenceNotices) {
		if (t.syncing) return;
		syncNotice = await t.startSync();
	}
	try {
		const { vault } = t.app;
		const adapter = vault.adapter;

		if (!t.accessToken.token) {
			if (!(await refreshAccessToken(t))) {
				new Notice(
					'Failed to refresh access token. Please re-authenticate.',
				);
				t.abortSync(syncNotice);
				return false;
			}
		}

		const recentlyModified = await t.drive.searchFiles({
			include: ['id', 'modifiedTime', 'properties', 'mimeType'],
			matches: [
				{
					modifiedTime: {
						gt: new Date(t.settings.lastSyncedAt).toISOString(),
					},
				},
			],
		});
		if (!recentlyModified) {
			new Notice('An error occurred fetching Google Drive files.');
			t.abortSync(syncNotice);
			return false;
		}

		const cloudSet = new Set(
			Object.values(t.settings.driveIdToPath).filter(
				(path) =>
					!path.startsWith(vault.configDir + '/') &&
					path !== vault.configDir,
			),
		);

		const localSet = new Set(
			vault
				.getAllLoadedFiles()
				.map((file) => file.path)
				.filter((path) => path !== '/'),
		);

		cloudSet.forEach((path) => {
			if (!localSet.has(path)) {
				t.settings.operations[path] = 'delete';
			}
		});

		for (const path in t.settings.operations) {
			if (
				path === vault.configDir ||
				path.startsWith(vault.configDir + '/')
			) {
				continue;
			}

			const operation = t.settings.operations[path];
			const existsLocally = localSet.has(path);

			if (operation === 'delete' && existsLocally) {
				t.settings.operations[path] = 'modify';
			} else if (operation === 'create' && !existsLocally) {
				delete t.settings.operations[path];
			} else if (operation === 'modify' && !existsLocally) {
				t.settings.operations[path] = 'delete';
			}
		}

		recentlyModified.forEach(({ properties }) =>
			cloudSet.add(unSplitPath(properties)),
		);

		localSet.forEach((path) => {
			if (!cloudSet.has(path)) {
				t.settings.operations[path] = 'create';
			}
		});

		const changes = await t.drive.getChanges(t.settings.changesToken);
		if (!changes) {
			new Notice('An error occurred fetching Google Drive changes.');
			t.abortSync(syncNotice);
			return false;
		}
		const removedPaths = Object.fromEntries(
			changes
				.filter(({ removed }) => removed)
				.map(({ fileId }) => [
					fileId,
					t.settings.driveIdToPath[fileId],
				]),
		);

		const deletions = changes
			.filter(({ removed }) => removed)
			.map(({ fileId }) => {
				const path = t.settings.driveIdToPath[fileId];
				if (!path) return;
				delete t.settings.driveIdToPath[fileId];

				const file = vault.getAbstractFileByPath(path);

				if (!file && t.settings.operations[path] === 'delete') {
					delete t.settings.operations[path];
					return;
				}
				return file;
			});

		if (!recentlyModified.length && !deletions.length) {
			if (silenceNotices) return true;
			const ended = await t.endSync(syncNotice);
			if (ended) new Notice("You're up to date!");
			return ended;
		}

		const pathToId = Object.fromEntries(
			Object.entries(t.settings.driveIdToPath).map(([id, path]) => [
				path,
				id,
			]),
		);

		const updateMap = () => {
			recentlyModified.forEach(({ id, properties }) => {
				pathToId[unSplitPath(properties)] = id;
			});

			t.settings.driveIdToPath = Object.fromEntries(
				Object.entries(pathToId).map(([path, id]) => [id, path]),
			);
		};

		updateMap();

		const deleteFiles = async () => {
			const deletedFiles = deletions
				.filter((file) => file instanceof TFile)
				.filter((file: TFile) => {
					if (t.settings.operations[file.path] === 'modify') {
						if (!pathToId[file.path]) {
							t.settings.operations[file.path] = 'create';
						}
						return;
					}
					return true;
				});

			const deletionPaths = deletions.map((file) => file?.path);

			const deletedFolders = deletions
				.filter((folder) => folder instanceof TFolder)
				.filter((folder: TFolder) => {
					if (pathToId[folder.path]) return;
					if (
						folder.children.find(
							({ path }) => !deletionPaths.includes(path),
						)
					) {
						return true;
					}
					t.settings.operations[folder.path] = 'create';
					return;
				});

			await t.drive.deleteFilesMinimumOperations([
				...deletedFolders,
				...deletedFiles,
			]);
		};

		await deleteFiles();

		syncNotice?.setMessage('Syncing (33%)');

		const upsertFiles = async () => {
			const newFolders = recentlyModified.filter(
				({ mimeType }) => mimeType === folderMimeType,
			);

			if (newFolders.length) {
				const batches = foldersToBatches(
					newFolders.map(({ properties }) => unSplitPath(properties)),
				);

				for (const batch of batches) {
					await Promise.all(
						batch.map(async (folder) => {
							delete t.settings.operations[folder];
							if (
								vault.getFolderByPath(folder) ||
								(await adapter.exists(folder))
							) {
								return;
							}
							return t.createFolder(folder);
						}),
					);
				}
			}

			let completed = 0;

			const newNotes = recentlyModified.filter(
				({ mimeType }) => mimeType !== folderMimeType,
			);

			await batchAsync(
				newNotes.map((file: FileMetadata) => async () => {
					const path = unSplitPath(file.properties);
					const localFile =
						vault.getFileByPath(path) ||
						(await adapter.exists(path));
					const operation = t.settings.operations[path];

					completed++;

					if (localFile && operation === 'modify') {
						return;
					}

					if (localFile && operation === 'create') {
						t.settings.operations[path] = 'modify';
						return;
					}

					const content = await t.drive
						.getFile(file.id)
						.arrayBuffer();

					syncNotice?.setMessage(
						getSyncMessage(33, 100, completed, newNotes.length),
					);

					if (localFile instanceof TFile) {
						return t.modifyFile(
							localFile,
							content,
							file.modifiedTime,
						);
					}

					return t.upsertFile(path, content, file.modifiedTime);
				}),
			);
		};

		await upsertFiles();

		const deleteConfigs = async () => {
			const configDeletions = await Promise.all(
				changes
					.filter(({ removed }) => removed)
					.map(async ({ fileId }) => {
						const path = removedPaths[fileId];
						if (!path || vault.getAbstractFileByPath(path)) return;
						const stat = await adapter.stat(path);
						if (!stat) return;
						return { path, type: stat.type };
					}),
			);

			let configDeletionsFiltered = configDeletions.filter(Boolean) as {
				path: string;
				type: 'file' | 'folder';
			}[];

			const trashMethod = (
				vault as unknown as {
					getConfig: (key: 'trashOption') => 'local' | 'system';
				}
			).getConfig('trashOption');

			if (trashMethod === 'local' || trashMethod === 'system') {
				const deletionMethod =
					trashMethod === 'local'
						? adapter.trashLocal.bind(adapter)
						: adapter.trashSystem.bind(adapter);

				const folders = configDeletionsFiltered.filter(
					(file) => file.type === 'folder',
				);

				if (folders.length) {
					const maxDepth = Math.max(
						...folders.map(({ path }) => path.split('/').length),
					);

					for (let depth = 1; depth <= maxDepth; depth++) {
						const foldersToDelete = configDeletionsFiltered.filter(
							(file) =>
								file.type === 'folder' &&
								file.path.split('/').length === depth,
						);
						await Promise.all(
							foldersToDelete.map(({ path }) =>
								deletionMethod(path),
							),
						);
						foldersToDelete.forEach(
							(folder) =>
								(configDeletionsFiltered =
									configDeletionsFiltered.filter(
										({ path }) =>
											!path.startsWith(
												folder.path + '/',
											) && path !== folder.path,
									)),
						);
					}
				}

				await Promise.all(
					configDeletionsFiltered.map(({ path }) =>
						deletionMethod(path),
					),
				);
				return;
			}

			const deletedFiles = configDeletionsFiltered.filter(
				(file) => file.type === 'file',
			);
			await Promise.all(
				deletedFiles.map(({ path }) => adapter.remove(path)),
			);

			const deletedFolders = configDeletionsFiltered.filter(
				(file) => file.type === 'folder',
			);
			const batches = foldersToBatches(
				deletedFolders.map(({ path }) => path),
			);
			batches.reverse();

			for (const batch of batches) {
				await Promise.all(
					batch.map(async (folder) => {
						const list = await adapter.list(folder);
						if (list.files.length + list.folders.length) return;
						void adapter.rmdir(folder, false);
					}),
				);
			}
		};

		await deleteConfigs();

		if (silenceNotices) return true;

		const ended = await t.endSync(syncNotice);
		if (ended) new Notice('Files have been synced from Google Drive!');
		return ended;
	} catch (error) {
		t.abortSync(syncNotice);
		new Notice('Sync failed unexpectedly. Please try again.');
		console.error('Google Drive pull failed', error);
		return false;
	}
};
