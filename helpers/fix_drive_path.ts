import { Notice } from 'obsidian';
import ObsidianGoogleDrive from '../main';
import { unSplitPath } from './drive';

export const fixDrivePath = async (t: ObsidianGoogleDrive) => {
	const driveFiles = await t.drive.searchFiles({
		include: ['id', 'properties'],
	});
	if (!driveFiles) {
		new Notice('An error occurred fetching Google Drive files.');
		return;
	}
	const idToPath = Object.fromEntries(
		driveFiles.map(({ id, properties }) => [id, unSplitPath(properties)]),
	);
	t.settings.driveIdToPath = idToPath;
	t.settings.operations = {};
	new Notice(
		'Google Drive paths have been fixed. Please restart the plugin to apply changes.',
	);
};
