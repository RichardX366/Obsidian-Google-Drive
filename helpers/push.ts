import ObsidianGoogleDrive from "main";
import { Notice, TFile, TFolder } from "obsidian";
import { batchAsyncs } from "./drive";
import { pull } from "./pull";

export const push = async (t: ObsidianGoogleDrive) => {
	if (t.syncing) return;

	const syncNotice = t.startSync();

	const pulledFiles = await pull(t, true);

	const { vault } = t.app;

	const operations = Object.entries(t.settings.operations);
	const deletes = operations.filter(([_, op]) => op === "delete");
	const creates = operations.filter(([_, op]) => op === "create");
	const modifies = operations.filter(([_, op]) => op === "modify");

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

	if (creates.length) {
		const files = creates.map(([path]) =>
			vault.getAbstractFileByPath(path)
		);

		const pathsToIds = Object.fromEntries(
			Object.entries(t.settings.driveIdToPath).map(([id, path]) => [
				path,
				id,
			])
		);

		const folders = files.filter(
			(file) => file instanceof TFolder
		) as TFolder[];

		const batches: TFolder[][] = new Array(
			Math.max(...folders.map(({ path }) => path.split("/").length))
		).fill([]);

		folders.forEach((folder) => {
			batches[folder.path.split("/").length - 1].push(folder);
		});

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
					t.settings.driveIdToPath[id] = folder.path;
					pathsToIds[folder.path] = id;
				})
			);
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
				t.settings.driveIdToPath[id] = note.path;
			})
		);
	}

	if (modifies.length) {
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
			})
		);
	}

	t.settings.operations = {};

	await t.endSync(syncNotice);

	if (pulledFiles === true) {
		return new Notice(
			"Sync complete, but some files were pulled from Google Drive, so you should reload Obsidian.",
			0
		);
	}
	new Notice("Sync complete!");
};
