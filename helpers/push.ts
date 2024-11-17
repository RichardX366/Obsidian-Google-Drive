import ObsidianGoogleDrive from "main";
import { Modal, Notice, setIcon, Setting, TFile, TFolder } from "obsidian";
import {
	batchAsyncs,
	fileNameFromPath,
	folderMimeType,
	foldersToBatches,
	getSyncMessage,
} from "./drive";
import { pull } from "./pull";

const BLACKLISTED_CONFIG_FILES = [
	"graph.json",
	"workspace.json",
	"workspace-mobile.json",
];

const WHITELISTED_PLUGIN_FILES = [
	"manifest.json",
	"styles.css",
	"main.js",
	"data.json",
];

class ConfirmPushModal extends Modal {
	proceed: (res: boolean) => void;

	constructor(
		t: ObsidianGoogleDrive,
		initialOperations: [string, "create" | "delete" | "modify"][],
		proceed: (res: boolean) => void
	) {
		super(t.app);
		this.proceed = proceed;

		this.setTitle("Push confirmation");
		this.contentEl
			.createEl("p")
			.setText(
				"Do you want to push the following changes to Google Drive:"
			);
		const container = this.contentEl.createEl("div");

		const render = (operations: typeof initialOperations) => {
			container.empty();
			operations.map(([path, op]) => {
				const div = container.createDiv();
				div.addClass("operation-container");

				const p = div.createEl("p");
				p.createEl("b").setText(`${op[0].toUpperCase()}${op.slice(1)}`);
				p.createSpan().setText(`: ${path}`);

				if (
					op === "delete" &&
					operations.some(([file]) => path.startsWith(file + "/"))
				) {
					return;
				}

				const btn = div.createDiv().createEl("button");
				setIcon(btn, "trash-2");
				btn.onclick = async () => {
					const nestedFiles = operations
						.map(([file]) => file)
						.filter(
							(file) =>
								file.startsWith(path + "/") || file === path
						);
					const proceed = await new Promise<boolean>((resolve) => {
						new ConfirmUndoModal(
							t,
							op,
							nestedFiles,
							resolve
						).open();
					});

					if (!proceed) return;

					nestedFiles.forEach(
						(file) => delete t.settings.operations[file]
					);
					const newOperations = operations.filter(
						([file]) => !nestedFiles.includes(file)
					);
					if (!newOperations.length) return this.close();
					render(newOperations);
				};
			});
		};

		render(initialOperations);

		new Setting(this.contentEl)
			.addButton((btn) =>
				btn.setButtonText("Cancel").onClick(() => this.close())
			)
			.addButton((btn) =>
				btn
					.setButtonText("Confirm")
					.setCta()
					.onClick(() => {
						proceed(true);
						this.close();
					})
			);
	}

	onClose() {
		this.proceed(false);
	}
}

class ConfirmUndoModal extends Modal {
	proceed: (res: boolean) => void;
	t: ObsidianGoogleDrive;
	filePathToId: Record<string, string>;

	constructor(
		t: ObsidianGoogleDrive,
		operation: "create" | "delete" | "modify",
		files: string[],
		proceed: (res: boolean) => void
	) {
		super(t.app);
		this.t = t;
		this.filePathToId = Object.fromEntries(
			Object.entries(this.t.settings.driveIdToPath).map(([id, path]) => [
				path,
				id,
			])
		);

		const operationMap = {
			create: "creating",
			delete: "deleting",
			modify: "modifying",
		};

		this.setTitle("Undo confirmation");
		this.contentEl
			.createEl("p")
			.setText(
				`Are you sure you want to undo ${operationMap[operation]} the following file(s):`
			);
		this.contentEl.createEl("ul").append(
			...files.map((file) => {
				const li = this.contentEl.createEl("li");
				li.addClass("operation-file");
				li.setText(file);
				return li;
			})
		);
		this.proceed = proceed;
		new Setting(this.contentEl)
			.addButton((btn) =>
				btn.setButtonText("Cancel").onClick(() => this.close())
			)
			.addButton((btn) =>
				btn
					.setButtonText("Confirm")
					.setCta()
					.onClick(async () => {
						btn.setDisabled(true);
						if (operation === "delete") {
							await this.handleDelete(files);
						}
						if (operation === "create") {
							await this.handleCreate(files[0]);
						}
						if (operation === "modify") {
							await this.handleModify(files[0]);
						}
						proceed(true);
						this.close();
					})
			);
	}

	onClose() {
		this.proceed(false);
	}

	async handleDelete(paths: string[]) {
		const files = await this.t.drive.searchFiles({
			include: ["id", "mimeType", "properties", "modifiedTime"],
			matches: paths.map((path) => ({ properties: { path } })),
		});
		if (!files) {
			return new Notice("An error occurred fetching Google Drive files.");
		}

		const pathToFile = Object.fromEntries(
			files.map((file) => [file.properties.path, file])
		);

		const deletedFolders = paths.filter(
			(path) => pathToFile[path].properties.path === folderMimeType
		);

		if (deletedFolders.length) {
			const batches = foldersToBatches(deletedFolders);

			for (const batch of batches) {
				await Promise.all(
					batch.map((folder) => this.t.createFolder(folder))
				);
			}
		}

		const deletedFiles = paths.filter(
			(path) => pathToFile[path].properties.path !== folderMimeType
		);

		await batchAsyncs(
			deletedFiles.map((path) => async () => {
				const onlineFile = await this.t.drive
					.getFile(this.filePathToId[path])
					.arrayBuffer();
				if (!onlineFile) {
					return new Notice(
						"An error occurred fetching Google Drive files."
					);
				}
				return this.t.createFile(
					path,
					onlineFile,
					pathToFile[path].modifiedTime
				);
			})
		);
	}

	async handleCreate(path: string) {
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!file) return;
		return this.t.deleteFile(file);
	}

	async handleModify(path: string) {
		const file = this.app.vault.getFileByPath(path);
		if (!file) return;

		const [onlineFile, metadata] = await Promise.all([
			this.t.drive.getFile(this.filePathToId[path]).arrayBuffer(),
			this.t.drive.searchFiles({
				matches: [{ id: this.filePathToId[path] }],
				include: ["modifiedTime"],
			}),
		]);
		if (!onlineFile || !metadata || !metadata.length) {
			return new Notice("An error occurred fetching Google Drive files.");
		}
		return this.t.modifyFile(file, onlineFile, metadata[0].modifiedTime);
	}
}

export const push = async (t: ObsidianGoogleDrive) => {
	if (t.syncing) return;
	const initialOperations = Object.entries(t.settings.operations).sort(
		([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)
	); // Alphabetical

	const { vault } = t.app;
	const adapter = vault.adapter;

	const proceed = await new Promise<boolean>((resolve) => {
		new ConfirmPushModal(t, initialOperations, resolve).open();
	});

	if (!proceed) return;

	const syncNotice = await t.startSync();

	await pull(t, true);

	const operations = Object.entries(t.settings.operations);

	const deletes = operations.filter(([_, op]) => op === "delete");
	const creates = operations.filter(([_, op]) => op === "create");
	const modifies = operations.filter(([_, op]) => op === "modify");

	const pathsToIds = Object.fromEntries(
		Object.entries(t.settings.driveIdToPath).map(([id, path]) => [path, id])
	);

	if (deletes.length) {
		const ids = await t.drive.idsFromPaths(deletes.map(([path]) => path));
		if (!ids) {
			return new Notice("An error occurred fetching Google Drive files.");
		}
		if (ids.length) {
			const deleteRequest = await t.drive.batchDelete(
				ids.map(({ id }) => id)
			);
			if (!deleteRequest) {
				return new Notice(
					"An error occurred deleting Google Drive files."
				);
			}
			ids.forEach(({ id }) => delete t.settings.driveIdToPath[id]);
		}
	}

	syncNotice.setMessage("Syncing (33%)");

	if (creates.length) {
		let completed = 0;
		const files = creates.map(([path]) =>
			vault.getAbstractFileByPath(path)
		);

		const folders = files.filter(
			(file) => file instanceof TFolder
		) as TFolder[];

		if (folders.length) {
			const batches = foldersToBatches(folders);

			for (const batch of batches) {
				await batchAsyncs(
					batch.map((folder) => async () => {
						const id = await t.drive.createFolder({
							name: folder.name,
							parent: folder.parent
								? pathsToIds[folder.parent.path]
								: undefined,
							properties: { path: folder.path },
							modifiedTime: new Date().toISOString(),
						});
						if (!id) {
							return new Notice(
								"An error occurred creating Google Drive folders."
							);
						}

						completed++;
						syncNotice.setMessage(
							getSyncMessage(33, 66, completed, files.length)
						);

						t.settings.driveIdToPath[id] = folder.path;
						pathsToIds[folder.path] = id;
					})
				);
			}
		}

		const notes = files.filter((file) => file instanceof TFile) as TFile[];

		await batchAsyncs(
			notes.map((note) => async () => {
				const id = await t.drive.uploadFile(
					new Blob([await vault.readBinary(note)]),
					note.name,
					note.parent ? pathsToIds[note.parent.path] : undefined,
					{
						properties: { path: note.path },
						modifiedTime: new Date().toISOString(),
					}
				);
				if (!id) {
					return new Notice(
						"An error occurred creating Google Drive files."
					);
				}

				completed++;
				syncNotice.setMessage(
					getSyncMessage(33, 66, completed, files.length)
				);

				t.settings.driveIdToPath[id] = note.path;
			})
		);
	}

	if (modifies.length) {
		let completed = 0;

		const files = modifies
			.map(([path]) => vault.getFileByPath(path))
			.filter((file) => file instanceof TFile) as TFile[];

		const pathToId = Object.fromEntries(
			Object.entries(t.settings.driveIdToPath).map(([id, path]) => [
				path,
				id,
			])
		);

		await batchAsyncs(
			files.map((file) => async () => {
				const id = await t.drive.updateFile(
					pathToId[file.path],
					new Blob([await vault.readBinary(file)]),
					{ modifiedTime: new Date().toISOString() }
				);
				if (!id) {
					return new Notice(
						"An error occurred modifying Google Drive files."
					);
				}

				completed++;
				syncNotice.setMessage(
					getSyncMessage(66, 99, completed, files.length)
				);
			})
		);
	}

	const configFilesToSync: string[] = [];

	const [configFiles, plugins] = await Promise.all([
		adapter.list(vault.configDir),
		adapter.list(vault.configDir + "/plugins"),
	]);

	await Promise.all(
		configFiles.files
			.filter(
				(path) =>
					!BLACKLISTED_CONFIG_FILES.includes(fileNameFromPath(path))
			)
			.map(async (path) => {
				const file = await adapter.stat(path);
				if ((file?.mtime || 0) > t.settings.lastSyncedAt) {
					configFilesToSync.push(path);
				}
			})
			.concat(
				plugins.folders.map(async (plugin) => {
					const files = await adapter.list(plugin);
					await Promise.all(
						files.files
							.filter((path) =>
								WHITELISTED_PLUGIN_FILES.includes(
									fileNameFromPath(path)
								)
							)
							.map(async (path) => {
								const file = await adapter.stat(path);
								if (
									(file?.mtime || 0) > t.settings.lastSyncedAt
								) {
									configFilesToSync.push(path);
								}
							})
					);
				})
			)
	);

	const foldersToCreate = new Set<string>();
	configFilesToSync.forEach((path) => {
		const parts = path.split("/");
		for (let i = 1; i < parts.length; i++) {
			foldersToCreate.add(parts.slice(0, i).join("/"));
		}
	});

	foldersToCreate.forEach((folder) => {
		if (pathsToIds[folder]) foldersToCreate.delete(folder);
	});

	if (foldersToCreate.size) {
		const batches = foldersToBatches(Array.from(foldersToCreate));

		for (const batch of batches) {
			await batchAsyncs(
				batch.map((folder) => async () => {
					const id = await t.drive.createFolder({
						name: folder.split("/").pop() || "",
						parent: pathsToIds[
							folder.split("/").slice(0, -1).join("/")
						],
						properties: { path: folder },
						modifiedTime: new Date().toISOString(),
					});
					if (!id) {
						return new Notice(
							"An error occurred creating Google Drive folders."
						);
					}

					t.settings.driveIdToPath[id] = folder;
					pathsToIds[folder] = id;
				})
			);
		}

		await batchAsyncs(
			configFilesToSync.map((path) => async () => {
				if (pathsToIds[path]) {
					await t.drive.updateFile(
						pathsToIds[path],
						new Blob([await adapter.readBinary(path)]),
						{ modifiedTime: new Date().toISOString() }
					);
					return;
				}

				const id = await t.drive.uploadFile(
					new Blob([await adapter.readBinary(path)]),
					fileNameFromPath(path),
					pathsToIds[path.split("/").slice(0, -1).join("/")],
					{
						properties: { path },
						modifiedTime: new Date().toISOString(),
					}
				);
				if (!id) {
					return new Notice(
						"An error occurred creating Google Drive config files."
					);
				}

				t.settings.driveIdToPath[id] = path;
			})
		);
	}

	await t.drive.updateFile(
		pathsToIds[vault.configDir + "/plugins/google-drive-sync/data.json"],
		new Blob([JSON.stringify(t.settings, null, 2)]),
		{ modifiedTime: new Date().toISOString() }
	);

	t.settings.operations = {};

	await t.endSync(syncNotice);

	new Notice("Sync complete!");
};
