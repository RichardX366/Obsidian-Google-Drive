import { describe, expect, it, vi } from 'vitest';

vi.mock('obsidian', () => {
	class TAbstractFile {
		path: string;
		constructor(path: string) {
			this.path = path;
		}
	}
	class TFile extends TAbstractFile {}
	return {
		App: class {},
		Menu: class {},
		Modal: class {},
		Notice: class {},
		Plugin: class {},
		PluginSettingTab: class {},
		Setting: class {},
		TAbstractFile,
		TFile,
		TFolder: class extends TAbstractFile {},
		debounce: (callback: unknown) => callback,
		requestUrl: vi.fn(),
		setIcon: vi.fn(),
	};
});

import { TFile } from 'obsidian';
import ObsidianGoogleDrive from '../main';

const createPlugin = () =>
	Object.assign(Object.create(ObsidianGoogleDrive.prototype), {
		settings: {
			refreshToken: 'refresh',
			operations: {},
			driveIdToPath: {},
			rootFolderId: '',
			lastSyncedAt: 0,
			changesToken: 'old-token',
		},
		debouncedSaveSettings: vi.fn(),
		saveSettings: vi.fn(async () => undefined),
		ribbonIcon: {
			addClass: vi.fn(),
			removeClass: vi.fn(),
		},
		drive: {
			getConfigFilesToSync: vi.fn(async () => []),
			getChangesStartToken: vi.fn(async () => 'new-token'),
		},
		app: {
			vault: {
				adapter: {
					readBinary: vi.fn(),
					writeBinary: vi.fn(),
				},
			},
		},
		syncing: true,
	}) as ObsidianGoogleDrive;

describe('ObsidianGoogleDrive operation tracking', () => {
	it('turns recreation of a deleted file into a modification', () => {
		const plugin = createPlugin();
		plugin.settings.operations['note.md'] = 'delete';
		const file = new TFile();
		Object.assign(file, { path: 'note.md' });

		plugin.handleCreate(file);

		expect(plugin.settings.operations['note.md']).toBe('modify');
	});

	it('cancels a pending create when the file is deleted', () => {
		const plugin = createPlugin();
		plugin.settings.operations['note.md'] = 'create';
		const file = new TFile();
		Object.assign(file, { path: 'note.md' });

		plugin.handleDelete(file);

		expect(plugin.settings.operations).not.toHaveProperty('note.md');
	});
});

describe('ObsidianGoogleDrive sync lifecycle', () => {
	it('stores a new checkpoint only after it is available', async () => {
		vi.spyOn(Date, 'now').mockReturnValue(1234);
		const plugin = createPlugin();

		await expect(plugin.endSync(undefined, false)).resolves.toBe(true);

		expect(plugin.settings.lastSyncedAt).toBe(1234);
		expect(plugin.settings.changesToken).toBe('new-token');
		expect(plugin.saveSettings).toHaveBeenCalledOnce();
		expect(plugin.syncing).toBe(false);
	});

	it('leaves the previous checkpoint intact when fetching one fails', async () => {
		const plugin = createPlugin();
		plugin.drive.getChangesStartToken = vi.fn(async () => undefined);

		await expect(plugin.endSync(undefined, false)).resolves.toBe(false);

		expect(plugin.settings.lastSyncedAt).toBe(0);
		expect(plugin.settings.changesToken).toBe('old-token');
		expect(plugin.saveSettings).not.toHaveBeenCalled();
		expect(plugin.syncing).toBe(false);
	});
});
