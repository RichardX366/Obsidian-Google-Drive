import { checkConnection, getDriveClient } from './helpers/drive';
import { refreshAccessToken } from './helpers/requests';
import { pull } from './helpers/pull';
import { push } from './helpers/push';
import { reset } from './helpers/reset';
import {
	App,
	debounce,
	Notice,
	Plugin,
	PluginSettingTab,
	type SettingDefinitionItem,
	TAbstractFile,
	TFile,
	Menu,
} from 'obsidian';

interface PluginSettings {
	refreshToken: string;
	autoPush: boolean;
	operations: Record<string, 'create' | 'delete' | 'modify'>;
	driveIdToPath: Record<string, string>;
	rootFolderId: string;
	lastSyncedAt: number;
	changesToken: string;
}

const DEFAULT_SETTINGS: PluginSettings = {
	refreshToken: '',
	autoPush: false,
	operations: {},
	driveIdToPath: {},
	rootFolderId: '',
	lastSyncedAt: 0,
	changesToken: '',
};

export default class ObsidianGoogleDrive extends Plugin {
	settings!: PluginSettings;
	accessToken = {
		token: '',
		expiresAt: 0,
	};
	drive = getDriveClient(this);
	ribbonIcon!: HTMLElement;
	syncing!: boolean;
	autoPushTimer?: number;

	async onload() {
		const { vault } = this.app;

		await this.loadSettings();

		this.addSettingTab(new SettingsTab(this.app, this));

		if (!this.settings.refreshToken) {
			new Notice(
				"Please add your refresh token to Google Drive sync through our website or our readme/this plugin's settings. If you haven't already, please read through this plugin's readme or website for instructions on how to use this plugin. Be careful of your first sync, and make sure to back up your data before your first sync.",
				10000,
			);
			return;
		}

		this.ribbonIcon = this.addRibbonIcon(
			'refresh-cw',
			'Obsidian Google Drive',
			(event) => {
				if (this.syncing) return;
				const menu = new Menu();

				menu.addItem((item) =>
					item
						.setTitle('Pull from Google Drive')
						.setIcon('cloud-download')
						.onClick(() => {
							void pull(this);
						}),
				);

				menu.addItem((item) =>
					item
						.setTitle('Push to Google Drive')
						.setIcon('cloud-upload')
						.onClick(() => {
							void push(this);
						}),
				);
				menu.addItem((item) =>
					item
						.setTitle('Reset from Google Drive')
						.setIcon('triangle-alert')
						.onClick(() => {
							void reset(this);
						}),
				);
				menu.showAtMouseEvent(event);
			},
		);

		this.addCommand({
			id: 'push',
			name: 'Push to Google Drive',
			callback: () => push(this),
		});

		this.addCommand({
			id: 'pull',
			name: 'Pull from Google Drive',
			callback: () => pull(this),
		});

		this.addCommand({
			id: 'reset',
			name: 'Reset local vault to Google Drive',
			callback: () => reset(this),
		});

		this.registerEvent(
			this.app.workspace.on('quit', () => this.saveSettings()),
		);

		this.app.workspace.onLayoutReady(() =>
			this.registerEvent(
				vault.on('create', this.handleCreate.bind(this)),
			),
		);
		this.registerEvent(vault.on('delete', this.handleDelete.bind(this)));
		this.registerEvent(vault.on('modify', this.handleModify.bind(this)));
		this.registerEvent(vault.on('rename', this.handleRename.bind(this)));

		void checkConnection().then(async (connected) => {
			if (!connected) return;

			this.syncing = true;
			this.ribbonIcon.addClass('spin');
			try {
				if (await pull(this, true)) await this.endSync();
			} finally {
				if (this.syncing) this.abortSync();
			}
		});
	}

	onunload() {
		this.clearAutoPushTimer();
		void this.saveSettings();
		return;
	}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			(await this.loadData()) as PluginSettings,
		);
	}

	saveSettings() {
		return this.saveData(this.settings);
	}

	debouncedSaveSettings = debounce(this.saveSettings.bind(this), 500, true);

	clearAutoPushTimer() {
		if (this.autoPushTimer === undefined) return;
		window.clearTimeout(this.autoPushTimer);
		this.autoPushTimer = undefined;
	}

	scheduleAutoPush() {
		this.clearAutoPushTimer();
		if (!this.settings.autoPush || this.syncing) return;

		this.autoPushTimer = window.setTimeout(() => {
			this.autoPushTimer = undefined;
			if (
				this.syncing ||
				!this.settings.autoPush ||
				!Object.keys(this.settings.operations).length
			) {
				return;
			}
			void push(this, true);
		}, 30_000);
	}

	resumeAutoPushIfNeeded() {
		if (Object.keys(this.settings.operations).length) {
			this.scheduleAutoPush();
		}
	}

	handleCreate(file: TAbstractFile) {
		if (this.settings.operations[file.path] === 'delete') {
			if (file instanceof TFile) {
				this.settings.operations[file.path] = 'modify';
			} else {
				delete this.settings.operations[file.path];
			}
		} else {
			this.settings.operations[file.path] = 'create';
		}
		this.debouncedSaveSettings();
		this.scheduleAutoPush();
	}

	handleDelete(file: TAbstractFile) {
		if (this.settings.operations[file.path] === 'create') {
			delete this.settings.operations[file.path];
		} else {
			this.settings.operations[file.path] = 'delete';
		}
		this.debouncedSaveSettings();
		this.scheduleAutoPush();
	}

	handleModify(file: TAbstractFile) {
		const operation = this.settings.operations[file.path];
		if (operation === 'create' || operation === 'modify') {
			this.scheduleAutoPush();
			return;
		}
		this.settings.operations[file.path] = 'modify';
		this.debouncedSaveSettings();
		this.scheduleAutoPush();
	}

	handleRename(file: TAbstractFile, oldPath: string) {
		this.handleDelete({ ...file, path: oldPath });
		this.handleCreate(file);
		this.debouncedSaveSettings();
	}

	async createFolder(path: string) {
		const oldOperation = this.settings.operations[path];
		await this.app.vault.createFolder(path);
		if (oldOperation) this.settings.operations[path] = oldOperation;
		else delete this.settings.operations[path];
	}

	async createFile(
		path: string,
		content: ArrayBuffer,
		modificationDate?: number | string | Date,
	) {
		const oldOperation = this.settings.operations[path];
		if (typeof modificationDate === 'string') {
			modificationDate = new Date(modificationDate);
		}
		if (modificationDate instanceof Date) {
			modificationDate = modificationDate.getTime();
		}

		await this.app.vault.createBinary(path, content, {
			mtime: modificationDate,
		});
		if (oldOperation) this.settings.operations[path] = oldOperation;
		else delete this.settings.operations[path];
	}

	async modifyFile(
		file: TFile,
		content: ArrayBuffer,
		modificationDate?: number | string | Date,
	) {
		const oldOperation = this.settings.operations[file.path];
		if (typeof modificationDate === 'string') {
			modificationDate = new Date(modificationDate);
		}
		if (modificationDate instanceof Date) {
			modificationDate = modificationDate.getTime();
		}

		await this.app.vault.modifyBinary(file, content, {
			mtime: modificationDate,
		});
		if (oldOperation) this.settings.operations[file.path] = oldOperation;
		else delete this.settings.operations[file.path];
	}

	async upsertFile(
		file: string,
		content: ArrayBuffer,
		modificationDate?: number | string | Date,
	) {
		const oldOperation = this.settings.operations[file];
		if (typeof modificationDate === 'string') {
			modificationDate = new Date(modificationDate);
		}
		if (modificationDate instanceof Date) {
			modificationDate = modificationDate.getTime();
		}

		await this.app.vault.adapter.writeBinary(file, content, {
			mtime: modificationDate,
		});
		if (oldOperation) this.settings.operations[file] = oldOperation;
		else delete this.settings.operations[file];
	}

	async deleteFile(file: TAbstractFile) {
		const oldOperation = this.settings.operations[file.path];
		await this.app.fileManager.trashFile(file);
		delete this.settings.operations[file.path];
		if (!oldOperation) delete this.settings.operations[file.path];
	}

	async startSync() {
		if (!(await checkConnection())) {
			new Notice(
				'You are not connected to the internet, so you cannot sync right now. Please try syncing once you have connection again.',
			);
			throw new Error('No internet connection');
		}
		this.clearAutoPushTimer();
		this.ribbonIcon.addClass('spin');
		this.syncing = true;
		return new Notice('Syncing (0%)', 0);
	}

	async endSync(syncNotice?: Notice, retainConfigChanges = true) {
		const syncedAt = Date.now();
		if (retainConfigChanges) {
			const configFilesToSync = await this.drive.getConfigFilesToSync();

			await Promise.all(
				configFilesToSync.map(async (file) =>
					this.app.vault.adapter.writeBinary(
						file,
						await this.app.vault.adapter.readBinary(file),
						{ mtime: Date.now() },
					),
				),
			);
		}

		const changesToken = await this.drive.getChangesStartToken();
		if (!changesToken) {
			new Notice(
				'An error occurred fetching Google Drive changes token.',
			);
			this.abortSync(syncNotice);
			return false;
		}
		this.settings.lastSyncedAt = syncedAt;
		this.settings.changesToken = changesToken;
		await this.saveSettings();
		this.ribbonIcon.removeClass('spin');
		this.syncing = false;
		syncNotice?.hide();
		this.resumeAutoPushIfNeeded();
		return true;
	}

	abortSync(syncNotice?: Notice) {
		this.ribbonIcon.removeClass('spin');
		this.syncing = false;
		syncNotice?.hide();
		this.resumeAutoPushIfNeeded();
	}
}

class SettingsTab extends PluginSettingTab {
	plugin: ObsidianGoogleDrive;

	constructor(app: App, plugin: ObsidianGoogleDrive) {
		super(app, plugin);
		this.plugin = plugin;
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		return [
			{
				name: 'Get refresh token',
				render: (setting) => {
					setting.settingEl.empty();
					setting.settingEl.createEl('a', {
						href: 'https://ogd.richardxiong.com',
						text: 'Get refresh token',
					});
				},
			},
			{
				name: 'Refresh token',
				desc: 'A refresh token is required to access your Google Drive for syncing. We suggest cloning your Google Drive vault to the current vault before syncing.',
				control: {
					type: 'text',
					key: 'refreshToken',
					placeholder: 'Refresh Token',
					validate: async (value: string) => {
						if (!value) {
							return 'Refresh token cannot be empty';
						}

						if (value === this.plugin.settings.refreshToken) {
							return;
						}

						if (!(await refreshAccessToken(this.plugin, value))) {
							return 'Failed to refresh access token.';
						}

						const changesToken =
							await this.plugin.drive.getChangesStartToken();
						if (!changesToken) {
							return 'An error occurred fetching Google Drive changes token.';
						}
						this.plugin.settings.changesToken = changesToken;

						await this.plugin.saveSettings();
						new Notice('Refresh token saved! Beginning to sync.');
						window.setTimeout(
							() => void this.plugin.onload(),
							1000,
						);
						return;
					},
				},
			},
			{
				name: 'Automatically push changes',
				desc: 'Push one minute after the most recent local file change.',
				control: {
					type: 'toggle',
					key: 'autoPush',
					defaultValue: false,
				},
			},
		];
	}

	async setControlValue(key: string, value: unknown) {
		await super.setControlValue(key, value);
		if (key === 'autoPush') {
			if (value) this.plugin.resumeAutoPushIfNeeded();
			else this.plugin.clearAutoPushTimer();
		}
	}
}
