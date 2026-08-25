import type ObsidianGoogleDrive from '../main';
import { getDriveAgent } from './requests';
import { requestUrl, TAbstractFile, TFolder } from 'obsidian';

export interface FileMetadata {
	id: string;
	name: string;
	description: string;
	mimeType: string;
	starred: boolean;
	properties: Record<string, string>;
	modifiedTime: string;
}

type StringSearch = string | { contains: string } | { not: string };
type DateComparison = { eq: string } | { gt: string } | { lt: string };

interface QueryMatch {
	name?: StringSearch | StringSearch[];
	mimeType?: StringSearch | StringSearch[];
	parent?: string;
	starred?: boolean;
	query?: string;
	properties?: Record<string, string>;
	modifiedTime?: DateComparison;
}

interface Change {
	kind: string;
	removed: boolean;
	file: FileMetadata;
	fileId: string;
	time: string;
}

export const folderMimeType = 'application/vnd.google-apps.folder';

const BLACKLISTED_CONFIG_FILES = [
	'graph.json',
	'workspace.json',
	'workspace-mobile.json',
];

const WHITELISTED_PLUGIN_FILES = [
	'manifest.json',
	'styles.css',
	'main.js',
	'data.json',
];

const escapeQueryValue = (value: string) =>
	value.replaceAll('\\', '\\\\').replaceAll("'", "\\'");

const stringSearchToQuery = (search: StringSearch) => {
	if (typeof search === 'string') return `='${escapeQueryValue(search)}'`;
	if ('contains' in search) {
		return ` contains '${escapeQueryValue(search.contains)}'`;
	}
	if ('not' in search) return `!='${escapeQueryValue(search.not)}'`;
	return;
};

const queryHandlers = {
	name: (name: StringSearch) => 'name' + stringSearchToQuery(name),
	mimeType: (mimeType: StringSearch) =>
		'mimeType' + stringSearchToQuery(mimeType),
	parent: (parent: string) => `'${escapeQueryValue(parent)}' in parents`,
	starred: (starred: boolean) => `starred=${starred}`,
	query: (query: string) => `fullText contains '${escapeQueryValue(query)}'`,
	properties: (properties: Record<string, string>) =>
		Object.entries(properties)
			.map(
				([key, value]) =>
					`properties has { key='${escapeQueryValue(key)}' and value='${escapeQueryValue(value)}' }`,
			)
			.join(' and '),
	modifiedTime: (modifiedTime: DateComparison) => {
		if ('eq' in modifiedTime) return `modifiedTime='${modifiedTime.eq}'`;
		if ('gt' in modifiedTime) return `modifiedTime>'${modifiedTime.gt}'`;
		if ('lt' in modifiedTime) return `modifiedTime<'${modifiedTime.lt}'`;
		return;
	},
};

export const fileListToMap = (files: { id: string; name: string }[]) =>
	Object.fromEntries(files.map(({ id, name }) => [name, id]));

export const splitPath = (path: string) => {
	const output: { [key: string]: string } = {
		path: path.substring(0, 100),
	};
	path = path.substring(100);
	let i = 2;
	while (path.length) {
		output[`path${i}`] = path.substring(0, 100);
		path = path.substring(100);
		i++;
	}
	return output;
};

export const unSplitPath = (properties: Record<string, string>) => {
	let path = properties.path || '';
	let i = 2;
	while (properties[`path${i}`]) {
		path += properties[`path${i}`];
		i++;
	}
	return path;
};

export const getDriveClient = (t: ObsidianGoogleDrive) => {
	const drive = getDriveAgent(t);

	const getQuery = (matches: QueryMatch[]) =>
		encodeURIComponent(
			`(${matches
				.map((match) => {
					const entries = Object.entries(match).flatMap(
						([key, value]) =>
							value === undefined
								? []
								: Array.isArray(value)
									? value.map((v) => [key, v as string])
									: [[key, value]],
					);
					return `(${entries
						.map(([key, value]) =>
							queryHandlers[key as keyof QueryMatch](
								value as never,
							),
						)
						.join(' and ')})`;
				})
				.join(
					' or ',
				)}) and trashed=false and properties has { key='vault' and value='${escapeQueryValue(t.app.vault.getName())}' }`,
		);

	const paginateFiles = async ({
		matches,
		pageToken,
		order = 'descending',
		pageSize = 30,
		include = [
			'id',
			'name',
			'mimeType',
			'starred',
			'description',
			'properties',
		],
	}: {
		matches?: QueryMatch[];
		order?: 'ascending' | 'descending';
		pageToken?: string;
		pageSize?: number;
		include?: (keyof FileMetadata)[];
	}) => {
		const files = await drive
			.get(
				`drive/v3/files?fields=nextPageToken,files(${include.join(
					',',
				)})&pageSize=${pageSize}&q=${
					matches
						? getQuery(matches)
						: "trashed=false and properties has { key='vault' and value='" +
							escapeQueryValue(t.app.vault.getName()) +
							"'}"
				}${
					matches?.find(({ query }) => query)
						? ''
						: '&orderBy=name' +
							(order === 'ascending' ? '' : ' desc')
				}${pageToken ? '&pageToken=' + pageToken : ''}`,
			)
			.json();
		if (!files) return;
		return files as {
			nextPageToken?: string;
			files: FileMetadata[];
		};
	};

	const searchFiles = async (
		data: {
			matches?: QueryMatch[];
			order?: 'ascending' | 'descending';
			include?: (keyof FileMetadata)[];
		},
		includeObsidian = false,
	) => {
		const files = await paginateFiles({ ...data, pageSize: 1000 });
		if (!files) return;

		while (files.nextPageToken) {
			const nextPage = await paginateFiles({
				...data,
				pageToken: files.nextPageToken,
				pageSize: 1000,
			});
			if (!nextPage) return;
			files.files.push(...nextPage.files);
			files.nextPageToken = nextPage.nextPageToken;
		}

		if (includeObsidian) return files.files;

		return files.files.filter(
			({ properties }) => properties?.obsidian !== 'vault',
		);
	};

	const getRootFolderId = async () => {
		const files = await searchFiles(
			{
				matches: [{ properties: { obsidian: 'vault' } }],
			},
			true,
		);
		if (!files) return;
		if (!files.length) {
			const rootFolder = await drive
				.post(`drive/v3/files`, {
					json: {
						name: t.app.vault.getName(),
						mimeType: folderMimeType,
						description: 'Obsidian Vault: ' + t.app.vault.getName(),
						properties: {
							obsidian: 'vault',
							vault: t.app.vault.getName(),
						},
					},
				})
				.json<{ id: string }>();
			if (!rootFolder) return;
			return rootFolder.id;
		} else {
			return files[0]?.id as string;
		}
	};

	const createFolder = async ({
		name,
		parent,
		description,
		properties,
		modifiedTime,
	}: {
		name: string;
		description?: string;
		parent?: string;
		properties?: Record<string, string>;
		modifiedTime?: string;
	}) => {
		if (!parent) {
			parent = await getRootFolderId();
			if (!parent) return;
		}

		if (!properties) properties = {};
		if (!properties.vault) properties.vault = t.app.vault.getName();

		const folder = await drive
			.post(`drive/v3/files`, {
				json: {
					name,
					mimeType: folderMimeType,
					description,
					parents: [parent],
					properties,
					modifiedTime,
				},
			})
			.json<{ id: string }>();
		if (!folder) return;
		return folder.id;
	};

	const uploadFile = async (
		file: Blob,
		name: string,
		parent?: string,
		metadata?: Partial<Omit<FileMetadata, 'id'>>,
	) => {
		if (!parent) {
			parent = await getRootFolderId();
			if (!parent) return;
		}

		if (!metadata) metadata = {};
		if (!metadata.properties) metadata.properties = {};
		if (!metadata.properties.vault) {
			metadata.properties.vault = t.app.vault.getName();
		}

		const form = new FormData();
		form.append(
			'metadata',
			new Blob(
				[
					JSON.stringify({
						name,
						mimeType: file.type,
						parents: [parent],
						...metadata,
					}),
				],
				{ type: 'application/json' },
			),
		);
		form.append('file', file);

		const result = await drive
			.post(`upload/drive/v3/files?uploadType=multipart&fields=id`, {
				body: form,
			})
			.json<{ id: string }>();
		if (!result) return;

		return result.id;
	};

	const updateFile = async (
		id: string,
		newContent: Blob,
		newMetadata: Partial<Omit<FileMetadata, 'id'>> = {},
	) => {
		const form = new FormData();
		form.append(
			'metadata',
			new Blob([JSON.stringify(newMetadata)], {
				type: 'application/json',
			}),
		);
		form.append('file', newContent);

		const result = await drive
			.patch(
				`upload/drive/v3/files/${id}?uploadType=multipart&fields=id`,
				{
					body: form,
				},
			)
			.json<{ id: string }>();
		if (!result) return;

		return result.id;
	};

	const updateFileMetadata = async (
		id: string,
		metadata: Partial<Omit<FileMetadata, 'id'>>,
	) => {
		const result = await drive
			.patch(`drive/v3/files/${id}`, {
				json: metadata,
			})
			.json<{ id: string }>();
		if (!result) return;
		return result.id;
	};

	const deleteFile = async (id: string) => {
		const result = await drive.delete(`drive/v3/files/${id}`);
		if (!result.ok) return;
		return true;
	};

	const getFile = (id: string) =>
		drive.get(`drive/v3/files/${id}?alt=media&acknowledgeAbuse=true`);

	const getFileMetadata = (id: string) =>
		drive.get(`drive/v3/files/${id}`).json<FileMetadata>();

	const idFromPath = async (path: string) => {
		const files = await searchFiles({
			matches: [{ properties: splitPath(path) }],
		});
		if (!files?.length) return;
		return files[0]?.id as string;
	};

	const idsFromPaths = async (paths: string[]) => {
		const files = await searchFiles({
			matches: paths.map((path) => ({ properties: splitPath(path) })),
		});
		if (!files) return;
		return files.map((file) => ({
			id: file.id,
			path: unSplitPath(file.properties),
		}));
	};

	const batchDelete = async (ids: string[]) => {
		if (!ids.length) return true;

		for (let offset = 0; offset < ids.length; offset += 100) {
			const batch = ids.slice(offset, offset + 100);
			const boundary = `batch_${crypto.randomUUID()}`;
			const body =
				batch
					.map((fileId, index) =>
						[
							`--${boundary}`,
							'Content-Type: application/http',
							`Content-ID: <request_${offset + index + 1}>`,
							'',
							`DELETE /drive/v3/files/${fileId} HTTP/1.1`,
							'',
						].join('\r\n'),
					)
					.concat(`--${boundary}--`)
					.join('\r\n') + '\r\n';

			const response = await drive.post(`batch/drive/v3`, {
				headers: {
					'Content-Type': `multipart/mixed; boundary=${boundary}`,
				},
				body,
			});
			if (!response.ok) return;

			const result = await response.text();
			const statuses = Array.from(
				result.matchAll(/HTTP\/1\.1 (\d{3})/g),
				(match) => Number(match[1]),
			);
			if (
				statuses.length !== batch.length ||
				statuses.some((status) => status < 200 || status >= 300)
			) {
				return;
			}
		}
		return true;
	};

	const getChangesStartToken = async () => {
		const result = await drive
			.get(`drive/v3/changes/startPageToken`)
			.json<{ startPageToken: string }>();
		if (!result) return;
		return result.startPageToken;
	};

	const getChanges = async (startToken: string) => {
		if (!startToken) return [];

		const request = (token: string) =>
			drive
				.get(
					`drive/v3/changes?${new URLSearchParams({
						pageToken: token,
						pageSize: '1000',
						includeRemoved: 'true',
					}).toString()}`,
				)
				.json<{
					changes: Change[];
					nextPageToken?: string;
					newStartPageToken?: string;
				}>();

		const result = await request(startToken);
		if (!result) return;
		while (result.nextPageToken) {
			const nextPage = await request(result.nextPageToken);
			if (!nextPage) return;
			result.changes.push(...nextPage.changes);
			result.newStartPageToken = nextPage.newStartPageToken;
			result.nextPageToken = nextPage.nextPageToken;
		}

		return result.changes;
	};

	const deleteFilesMinimumOperations = async (files: TAbstractFile[]) => {
		const folders = files.filter((file) => file instanceof TFolder);

		if (folders.length) {
			const maxDepth = Math.max(
				...folders.map(({ path }) => path.split('/').length),
			);

			for (let depth = 1; depth <= maxDepth; depth++) {
				const foldersToDelete = files.filter(
					(file) =>
						file instanceof TFolder &&
						file.path.split('/').length === depth,
				);
				await Promise.all(
					foldersToDelete.map((folder) => t.deleteFile(folder)),
				);
				foldersToDelete.forEach(
					(folder) =>
						(files = files.filter(
							({ path }) =>
								!path.startsWith(folder.path + '/') &&
								path !== folder.path,
						)),
				);
			}
		}

		await Promise.all(files.map((file) => t.deleteFile(file)));
	};

	const getConfigFilesToSync = async () => {
		const configFilesToSync: string[] = [];
		const { vault } = t.app;
		const { adapter } = vault;

		const [configFiles, plugins] = await Promise.all([
			adapter.list(vault.configDir),
			adapter.list(vault.configDir + '/plugins'),
		]);

		await Promise.all(
			configFiles.files
				.filter(
					(path) =>
						!BLACKLISTED_CONFIG_FILES.includes(
							fileNameFromPath(path),
						),
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
										fileNameFromPath(path),
									),
								)
								.map(async (path) => {
									const file = await adapter.stat(path);
									if (
										(file?.mtime || 0) >
										t.settings.lastSyncedAt
									) {
										configFilesToSync.push(path);
									}
								}),
						);
					}),
				),
		);

		return configFilesToSync;
	};

	return {
		paginateFiles,
		searchFiles,
		getRootFolderId,
		createFolder,
		uploadFile,
		updateFile,
		updateFileMetadata,
		deleteFile,
		getFile,
		getFileMetadata,
		idFromPath,
		idsFromPaths,
		getChangesStartToken,
		getChanges,
		batchDelete,
		checkConnection,
		deleteFilesMinimumOperations,
		getConfigFilesToSync,
	};
};

export const checkConnection = async () => {
	try {
		const result = await requestUrl({
			url: 'https://www.google.com/generate_204',
			throw: false,
		});
		return result.status >= 200 && result.status < 300;
	} catch {
		return false;
	}
};

export const batchAsync = async <T = unknown>(
	requests: (() => Promise<T>)[],
	batchSize = 10,
) => {
	const results = [];
	for (let i = 0; i < requests.length; i += batchSize) {
		const batch = requests.slice(i, i + batchSize);
		results.push(...(await Promise.all(batch.map((request) => request()))));
	}
	return results;
};

export const getSyncMessage = (
	min: number,
	max: number,
	completed: number,
	total: number,
) => `Syncing (${Math.floor(min + (max - min) * (completed / total))}%)`;

export const fileNameFromPath = (path: string) =>
	path.split('/').slice(-1)[0] as string;

/**
 * @returns Batches in increasing order of depth
 */
export const foldersToBatches = <T = string | TFolder>(folders: T[]) => {
	const batches: (typeof folders)[] = new Array(
		Math.max(
			...folders.map(
				(folder) =>
					(
						(folder instanceof TFolder
							? folder.path
							: folder) as string
					).split('/').length,
			),
		),
	)
		.fill(0)
		.map(() => []);

	folders.forEach((folder) => {
		batches[
			(
				(folder instanceof TFolder ? folder.path : folder) as string
			).split('/').length - 1
		]?.push(folder);
	});

	return batches;
};
