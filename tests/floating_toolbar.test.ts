import { describe, expect, it, vi } from 'vitest';

vi.stubGlobal('window', globalThis);

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
		addIcon: vi.fn(),
		debounce: (callback: unknown) => callback,
		requestUrl: vi.fn(),
		setIcon: vi.fn(),
	};
});

import ObsidianGoogleDrive from '../main';

const createPlugin = (actions: Record<string, boolean>) =>
	Object.assign(Object.create(ObsidianGoogleDrive.prototype), {
		settings: {
			toolbarPush: false,
			toolbarPull: false,
			toolbarFix: false,
			toolbarReset: false,
			...actions,
		},
	}) as ObsidianGoogleDrive;

describe('ObsidianGoogleDrive floating toolbar actions', () => {
	it('includes only the enabled actions, in order', () => {
		const plugin = createPlugin({ toolbarReset: true, toolbarPush: true });

		expect(plugin.toolbarActions().map(([, label]) => label)).toEqual([
			'Push to Google Drive',
			'Reset local vault to Google Drive',
		]);
	});

	it('maps an enabled action to its icon and label', () => {
		const plugin = createPlugin({ toolbarPull: true });

		expect(plugin.toolbarActions()).toEqual([
			['download-cloud', 'Pull from Google Drive', expect.any(Function)],
		]);
	});

	it('returns nothing when every action is disabled', () => {
		expect(createPlugin({}).toolbarActions()).toEqual([]);
	});
});
