import ObsidianGoogleDrive from "main";
import {
	batchAsyncs,
	cleanIgnoredOperations,
	folderMimeType,
	foldersToBatches,
	getSyncMessage,
} from "./drive";
import {
	Notice,
	TAbstractFile,
	TFile,
	TFolder,
	Modal,
	Setting,
} from "obsidian";
import { pull } from "./pull";

export class ConfirmResetModal extends Modal {
	proceed: (res: boolean) => void;
	constructor(t: ObsidianGoogleDrive, proceed: (res: boolean) => void) {
		super(t.app);
		this.proceed = proceed;

		this.setTitle(
			"Are you sure you want to reset the data from Google Drive?"
		);
		this.setContent(
			"You'll loose all the local changes to your data and load only the information on your google drive. This step is irreversible."
		);
		new Setting(this.contentEl)
			.addButton((btn) =>
				btn.setButtonText("Cancel").onClick(() => this.close())
			)
			.addButton((btn) =>
				btn
					.setButtonText("RESET!")
					.setWarning()
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

export const reset = async (t: ObsidianGoogleDrive) => {
	if (t.syncing) return;

	const proceed = await new Promise<boolean>((resolve) => {
		new ConfirmResetModal(t, resolve).open();
	});
	if (!proceed) return;

	const syncNotice = await t.startSync();

	await pull(t, true);
	cleanIgnoredOperations(t.settings.operations);

	const { vault } = t.app;

	const operations = Object.entries(t.settings.operations);
	const deletes = operations.filter(([_, op]) => op === "delete");
	const creates = operations.filter(([_, op]) => op === "create");
	const modifies = operations.filter(([_, op]) => op === "modify");

	const filePathToId = Object.fromEntries(
		Object.entries(t.settings.driveIdToPath).map(([id, path]) => [path, id])
	);

	if (creates.length) {
		await t.drive.deleteFilesMinimumOperations(
			creates
				.map(([path]) => vault.getAbstractFileByPath(path))
				.filter(
					(file) => file instanceof TAbstractFile
				) as TAbstractFile[]
		);
	}

	syncNotice.setMessage("Syncing (33%)");

	if (modifies.length) {
		let completed = 0;
		const files = modifies.map(([path]) =>
			vault.getFileByPath(path)
		) as TFile[];
		await batchAsyncs(
			files.map((file) => async () => {
				const [onlineFile, metadata] = await Promise.all([
					t.drive.getFile(filePathToId[file.path]).arrayBuffer(),
					t.drive.getFileMetadata(filePathToId[file.path]),
				]);
				if (!onlineFile || !metadata) {
					return new Notice(
						"An error occurred fetching Google Drive files."
					);
				}

				completed++;
				syncNotice.setMessage(
					getSyncMessage(33, 66, completed, files.length)
				);
				return t.modifyFile(file, onlineFile, metadata.modifiedTime);
			})
		);
	}

	if (deletes.length) {
		const files = await t.drive.searchFiles({
			include: ["id", "mimeType", "properties", "modifiedTime"],
			matches: deletes.map(([path]) => ({ properties: { path } })),
		});
		if (!files) {
			return new Notice("An error occurred fetching Google Drive files.");
		}

		const pathToFile = Object.fromEntries(
			files.map((file) => [file.properties.path, file])
		);

		const deletedFolders = deletes.filter(
			([path]) => pathToFile[path].mimeType === folderMimeType
		);

		if (deletedFolders.length) {
			const batches = foldersToBatches(
				deletedFolders.map(([path]) => path)
			);

			for (const batch of batches) {
				await Promise.all(
					batch.map((folder) => t.createFolder(folder))
				);
			}
		}

		let completed = 0;

		const deletedFiles = deletes.filter(
			([path]) => pathToFile[path].mimeType !== folderMimeType
		);

		await batchAsyncs(
			deletedFiles.map(([path]) => async () => {
				const onlineFile = await t.drive
					.getFile(filePathToId[path])
					.arrayBuffer();
				if (!onlineFile) {
					return new Notice(
						"An error occurred fetching Google Drive files."
					);
				}
				completed++;
				syncNotice.setMessage(
					getSyncMessage(66, 99, completed, deletedFiles.length)
				);
				return t.createFile(
					path,
					onlineFile,
					pathToFile[path].modifiedTime
				);
			})
		);
	}

	t.settings.operations = {};

	await t.endSync(syncNotice);

	new Notice("Reset complete.");
};
