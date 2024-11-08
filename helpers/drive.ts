import ObsidianGoogleDrive from "main";
import { getDriveKy } from "./ky";
import { KyInstance } from "ky";
import * as path from "path";

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

export const folderMimeType = "application/vnd.google-apps.folder";

const queryHandlers = {
	name: (name: StringSearch) => {
		if (typeof name === "string") return `name='${name}'`;
		if ("contains" in name) return `name contains '"${name.contains}"'`;
		if ("not" in name) return `name != '${name.not}'`;
	},
	mimeType: (mimeType: StringSearch) => {
		if (typeof mimeType === "string") return `mimeType='${mimeType}'`;
		if ("contains" in mimeType)
			return `mimeType contains '${mimeType.contains}'`;
		if ("not" in mimeType) return `mimeType != '${mimeType.not}'`;
	},
	parent: (parent: string) => `'${parent}' in parents`,
	starred: (starred: boolean) => `starred=${starred}`,
	query: (query: string) => `fullText contains '${query}'`,
	properties: (properties: Record<string, string>) =>
		Object.entries(properties).map(
			([key, value]) =>
				`properties has { key='${key}' and value='${value}' }`
		),
	modifiedTime: (modifiedTime: DateComparison) => {
		if ("eq" in modifiedTime) return `modifiedTime = '${modifiedTime.eq}'`;
		if ("gt" in modifiedTime) return `modifiedTime > '${modifiedTime.gt}'`;
		if ("lt" in modifiedTime) return `modifiedTime < '${modifiedTime.lt}'`;
	},
};

const getQuery = (matches: QueryMatch[]) =>
	encodeURIComponent(
		`(${matches
			.map((match) => {
				const entries = Object.entries(match).flatMap(([key, value]) =>
					value === undefined
						? []
						: Array.isArray(value)
						? value.map((v) => [key, v])
						: [[key, value]]
				);
				return `(${entries
					.map(([key, value]) =>
						queryHandlers[key as keyof QueryMatch](value as never)
					)
					.join(" and ")})`;
			})
			.join(" or ")}) and trashed=false`
	);

export const fileListToMap = (files: { id: string; name: string }[]) =>
	Object.fromEntries(files.map(({ id, name }) => [name, id]));

export const getDriveClient = (t: ObsidianGoogleDrive) => {
	const drive = getDriveKy(t);

	return {
		paginateFiles: paginateFiles(drive),
		searchFiles: searchFiles(drive),
		getRootFolderId: getRootFolderId(drive),
		createFolder: createFolder(drive),
		uploadFile: uploadFile(drive),
		updateFile: updateFile(drive),
		updateFileMetadata: updateFileMetadata(drive),
		deleteFile: deleteFile(drive),
		getFile: getFile(drive),
		idFromPath: idFromPath(drive),
		idsFromPaths: idsFromPaths(drive),
		batchDelete: batchDelete(drive),
	};
};

const paginateFiles =
	(drive: KyInstance) =>
	async ({
		matches,
		pageToken,
		order = "descending",
		pageSize = 30,
		include = [
			"id",
			"name",
			"mimeType",
			"starred",
			"description",
			"properties",
		],
	}: {
		matches?: QueryMatch[];
		order?: "ascending" | "descending";
		pageToken?: string;
		pageSize?: number;
		include?: (keyof FileMetadata)[];
	}) => {
		const files = await drive
			.get(
				`drive/v3/files?fields=nextPageToken,files(${include.join(
					","
				)})&pageSize=${pageSize}&q=${
					matches ? getQuery(matches) : "trashed=false"
				}${
					matches?.find(({ query }) => query)
						? ""
						: "&orderBy=name" +
						  (order === "ascending" ? "" : " desc")
				}${pageToken ? "&pageToken=" + pageToken : ""}`
			)
			.json<any>();
		if (!files) return;
		return files as {
			nextPageToken?: string;
			files: FileMetadata[];
		};
	};

const searchFiles =
	(drive: KyInstance) =>
	async (
		data: {
			matches?: QueryMatch[];
			order?: "ascending" | "descending";
			include?: (keyof FileMetadata)[];
		},
		includeObsidian = false
	) => {
		const files = await paginateFiles(drive)({ ...data, pageSize: 1000 });
		if (!files) return;

		while (files.nextPageToken) {
			const nextPage = await paginateFiles(drive)({
				...data,
				pageToken: files.nextPageToken,
				pageSize: 1000,
			});
			if (!nextPage) return;
			files.files.push(...nextPage.files);
			files.nextPageToken = nextPage.nextPageToken;
		}

		if (includeObsidian) return files.files as FileMetadata[];

		return files.files.filter(
			({ properties }) => properties?.obsidian !== "vault"
		) as FileMetadata[];
	};

const getRootFolderId = (drive: KyInstance) => async () => {
	const files = await searchFiles(drive)(
		{
			matches: [{ properties: { obsidian: "vault" } }],
		},
		true
	);
	if (!files) return;
	if (!files.length) {
		const rootFolder = await drive
			.post(`drive/v3/files`, {
				json: {
					name: "Obsidian",
					mimeType: folderMimeType,
					properties: { obsidian: "vault" },
				},
			})
			.json<any>();
		if (!rootFolder) return;
		return rootFolder.id as string;
	} else {
		return files[0].id as string;
	}
};

const createFolder =
	(drive: KyInstance) =>
	async ({
		name,
		parent,
		description,
		properties,
	}: {
		name: string;
		description?: string;
		parent?: string;
		properties?: Record<string, string>;
	}) => {
		if (!parent) {
			parent = await getRootFolderId(drive)();
			if (!parent) return;
		}
		const folder = await drive
			.post(`drive/v3/files`, {
				json: {
					name,
					mimeType: folderMimeType,
					description,
					parents: [parent],
					properties,
				},
			})
			.json<any>();
		if (!folder) return;
		return folder.id as string;
	};

const uploadFile =
	(drive: KyInstance) =>
	async (
		file: Blob,
		name: string,
		parent?: string,
		metadata?: Partial<Omit<FileMetadata, "id">>
	) => {
		if (!parent) {
			parent = await getRootFolderId(drive)();
			if (!parent) return;
		}

		const form = new FormData();
		form.append(
			"metadata",
			new Blob(
				[
					JSON.stringify({
						name,
						mimeType: file.type,
						parents: [parent],
						...metadata,
					}),
				],
				{ type: "application/json" }
			)
		);
		form.append("file", file);

		const result = await drive
			.post(`upload/drive/v3/files?uploadType=multipart&fields=id`, {
				body: form,
			})
			.json<any>();
		if (!result) return;

		return result.id as string;
	};

const updateFile =
	(drive: KyInstance) =>
	async (
		id: string,
		newContent: Blob,
		newMetadata: Partial<Omit<FileMetadata, "id">> = {}
	) => {
		const form = new FormData();
		form.append(
			"metadata",
			new Blob([JSON.stringify(newMetadata)], {
				type: "application/json",
			})
		);
		form.append("file", newContent);

		const result = await drive
			.patch(
				`upload/drive/v3/files/${id}?uploadType=multipart&fields=id`,
				{
					body: form,
				}
			)
			.json<any>();
		if (!result) return;

		return result.id as string;
	};

const updateFileMetadata =
	(drive: KyInstance) =>
	async (id: string, metadata: Partial<Omit<FileMetadata, "id">>) => {
		const result = await drive
			.patch(`drive/v3/files/${id}`, {
				json: metadata,
			})
			.json<any>();
		if (!result) return;
		return result.id as string;
	};

const deleteFile = (drive: KyInstance) => async (id: string) => {
	const result = await drive.delete(`drive/v3/files/${id}`);
	if (!result.ok) return;
	return true;
};

const getFile = (drive: KyInstance) => (id: string) =>
	drive.get(`drive/v3/files/${id}?alt=media`);

const idFromPath = (drive: KyInstance) => async (path: string) => {
	const files = await searchFiles(drive)({
		matches: [{ properties: { path } }],
	});
	if (!files?.length) return;
	return files[0].id as string;
};

const idsFromPaths = (drive: KyInstance) => async (paths: string[]) => {
	const files = await searchFiles(drive)({
		matches: paths.map((path) => ({ properties: { path } })),
	});
	if (!files) return;
	return files.map((file) => ({ id: file.id, path: file.properties.path }));
};

const batchDelete = (drive: KyInstance) => async (ids: string[]) => {
	const body = new FormData();

	// Loop through file IDs to create each delete request
	ids.forEach((fileId, index) => {
		const deleteRequest = [
			`--batch_boundary`,
			"Content-Type: application/http",
			"",
			`DELETE /drive/v3/files/${fileId} HTTP/1.1`,
			"",
			"",
		].join("\r\n");

		body.append(`request_${index + 1}`, deleteRequest);
	});

	body.append("", "--batch_boundary--");

	const result = await drive
		.post(`batch/drive/v3`, {
			headers: {
				"Content-Type": "multipart/mixed; boundary=batch_boundary",
			},
			body,
		})
		.text();
	if (!result) return;
	return result;
};

/*
	let body = ``;

	ids.forEach((id, i) => {
		body += `
--batch_boundary_foobarbiz
Content-Type: application/http
Content-ID: ${i}


DELETE https://www.googleapis.com/drive/v3/files/${id}


`;
	});

	body += "--batch_boundary_foobarbiz--";

	const result = await drive
		.post(`batch/drive/v3`, {
			headers: {
				"Content-Type":
					"multipart/mixed; boundary=batch_boundary_foobarbiz",
			},
			body,
		})
		.json<any>();
	if (!result) return;
	return result;
  */
