import { checkConnection, getDriveClient } from './helpers/drive';
import { refreshAccessToken } from './helpers/requests';
import { pull } from './helpers/pull';
import { push } from './helpers/push';
import { reset } from './helpers/reset';
import {
	addIcon,
	App,
	debounce,
	Notice,
	Plugin,
	PluginSettingTab,
	setIcon,
	type SettingDefinitionItem,
	TAbstractFile,
	TFile,
} from 'obsidian';
import { fixDrivePath } from './helpers/fix_drive_path';

// Lucide "refresh-cw" scaled from its 24px grid to Obsidian's 100px icon grid.
const OGD_SYNC_ICON =
	'<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" transform="scale(4.1667)">' +
	'<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />' +
	'<path d="M21 3v5h-5" />' +
	'<path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />' +
	'<path d="M3 21v-5h5" />' +
	'</g>';

interface PluginSettings {
	refreshToken: string;
	clientId: string;
	clientSecret: string;
	accessTokenUrl: string;
	autoPush: boolean;
	operations: Record<string, 'create' | 'delete' | 'modify'>;
	driveIdToPath: Record<string, string>;
	rootFolderId: string;
	lastSyncedAt: number;
	changesToken: string;
	enableFloatingToolbar: boolean;
	toolbarPush: boolean;
	toolbarPull: boolean;
	toolbarFix: boolean;
	toolbarReset: boolean;
}

const DEFAULT_SETTINGS: PluginSettings = {
	refreshToken: '',
	clientId: '',
	clientSecret: '',
	accessTokenUrl: '',
	autoPush: false,
	operations: {},
	driveIdToPath: {},
	rootFolderId: '',
	lastSyncedAt: 0,
	changesToken: '',
	enableFloatingToolbar: false,
	toolbarPush: true,
	toolbarPull: false,
	toolbarFix: false,
	toolbarReset: false,
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
	toolbarEl?: HTMLElement;
	toolbarOutsideClick?: (event: MouseEvent) => void;

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
			'Push to Google Drive',
			() => {
				if (this.syncing) return;
				void push(this);
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

		this.addCommand({
			id: 'fix-drive-path',
			name: 'Fix Google Drive paths',
			callback: () => fixDrivePath(this),
		});

		if (this.settings.enableFloatingToolbar) this.createFloatingToolbar();

		this.registerEvent(
			this.app.workspace.on('quit', () => this.saveSettings()),
		);

		this.app.workspace.onLayoutReady(() => {
			this.registerEvent(
				vault.on('create', this.handleCreate.bind(this)),
			);
			this.registerEvent(
				vault.on('delete', this.handleDelete.bind(this)),
			);
			this.registerEvent(
				vault.on('modify', this.handleModify.bind(this)),
			);
			this.registerEvent(
				vault.on('rename', this.handleRename.bind(this)),
			);

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
		});
	}

	onunload() {
		this.clearAutoPushTimer();
		this.removeFloatingToolbar();
		void this.saveSettings();
		return;
	}

	toolbarActions(): [string, string, () => void][] {
		const all: [keyof PluginSettings, string, string, () => void][] = [
			['toolbarPush', 'upload-cloud', 'Push to Google Drive', () =>
				void push(this)],
			['toolbarPull', 'download-cloud', 'Pull from Google Drive', () =>
				void pull(this)],
			['toolbarFix', 'wrench', 'Fix Google Drive paths', () =>
				void fixDrivePath(this)],
			['toolbarReset', 'rotate-ccw', 'Reset local vault to Google Drive', () =>
				void reset(this)],
		];
		return all
			.filter(([key]) => this.settings[key])
			.map(([, icon, label, action]) => [icon, label, action]);
	}

	setFloatingToolbarOpen(open: boolean) {
		const container = this.toolbarEl;
		if (!container) return;
		container.toggleClass('is-open', open);
		const launcher = container.querySelector<HTMLElement>(
			'.ogd-fab-launcher',
		);
		if (launcher) setIcon(launcher, open ? 'x' : 'ogd-sync');
		if (open) this.updateFloatingToolbarDirection();
	}

	// Open below instead of above when the button sits near the top of the screen.
	updateFloatingToolbarDirection() {
		const container = this.toolbarEl;
		if (!container) return;
		const top = container.getBoundingClientRect().top;
		container.toggleClass('open-below', top < window.innerHeight * 0.35);
	}

	createFloatingToolbar() {
		if (this.toolbarEl) return;

		const actions = this.toolbarActions();
		if (!actions.length) return;

		addIcon('ogd-sync', OGD_SYNC_ICON);

		const container = document.body.createDiv('ogd-fab');

		const menu = container.createDiv('ogd-fab-menu');
		for (const [icon, label, action] of actions) {
			const item = menu.createEl('button', {
				cls: 'ogd-fab-item',
				attr: { 'aria-label': label },
			});
			setIcon(item.createSpan('ogd-fab-item-icon'), icon);
			item.createSpan({ cls: 'ogd-fab-item-label', text: label });
			item.addEventListener('click', () => {
				if (this.syncing) return;
				action();
				this.setFloatingToolbarOpen(false);
			});
		}

		const launcher = container.createEl('button', {
			cls: 'ogd-fab-launcher',
			attr: { 'aria-label': 'Google Drive sync' },
		});
		setIcon(launcher, 'ogd-sync');
		this.makeFloatingToolbarDraggable(container, launcher);

		this.toolbarOutsideClick = (event) => {
			if (!container.contains(event.target as Node)) {
				this.setFloatingToolbarOpen(false);
			}
		};
		document.addEventListener('click', this.toolbarOutsideClick, true);

		document.body.appendChild(container);
		container.style.top = `${Math.round(window.innerHeight * 0.4)}px`;
		this.updateFloatingToolbarDirection();

		this.toolbarEl = container;
	}

	makeFloatingToolbarDraggable(container: HTMLElement, handle: HTMLElement) {
		let startY = 0;
		let startTop = 0;
		let dragging = false;
		let moved = false;

		handle.addEventListener('pointerdown', (event) => {
			dragging = true;
			moved = false;
			startY = event.clientY;
			startTop = container.getBoundingClientRect().top;
			handle.setPointerCapture(event.pointerId);
		});
		handle.addEventListener('pointermove', (event) => {
			if (!dragging) return;
			const delta = event.clientY - startY;
			if (Math.abs(delta) > 4) moved = true;
			const max = Math.max(8, window.innerHeight - container.offsetHeight - 8);
			container.style.top = `${Math.min(Math.max(8, startTop + delta), max)}px`;
			this.updateFloatingToolbarDirection();
		});
		const end = (event: PointerEvent) => {
			if (!dragging) return;
			dragging = false;
			try {
				handle.releasePointerCapture(event.pointerId);
			} catch {
				/* pointer already released */
			}
			// A press without movement is a click: toggle the menu.
			if (!moved) {
				this.setFloatingToolbarOpen(!container.hasClass('is-open'));
			}
		};
		handle.addEventListener('pointerup', end);
		handle.addEventListener('pointercancel', end);
	}

	removeFloatingToolbar() {
		if (this.toolbarOutsideClick) {
			document.removeEventListener('click', this.toolbarOutsideClick, true);
			this.toolbarOutsideClick = undefined;
		}
		this.toolbarEl?.remove();
		this.toolbarEl = undefined;
	}

	refreshFloatingToolbar() {
		this.removeFloatingToolbar();
		if (this.settings.enableFloatingToolbar) this.createFloatingToolbar();
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
		}, 60_000);
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
			if (file.path.includes('"')) {
				new Notice(
					`File path ${file.path} contains double quotes and will not be synced.`,
				);
				return;
			}
			this.settings.operations[file.path] = 'create';
		}
		this.debouncedSaveSettings();
		this.scheduleAutoPush();
	}

	handleDelete(file: TAbstractFile) {
		if (this.settings.operations[file.path] === 'create') {
			delete this.settings.operations[file.path];
		} else if (!file.path.includes('"')) {
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
							() =>
								void this.plugin
									.onload()
									.then(
										() =>
											new Notice(
												'Sync complete! Please close settings and restart Obsidian to see the changes properly sync.',
												0,
											),
									),
							1_000,
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
			{
				name: 'Floating toolbar',
				desc: 'Show a collapsible quick-access launcher on the right edge. Tap it to reveal the actions below.',
				control: {
					type: 'toggle',
					key: 'enableFloatingToolbar',
					defaultValue: false,
				},
			},
			{
				type: 'group',
				heading: 'Toolbar actions',
				cls: 'ogd-toolbar-actions',
				visible: () => this.plugin.settings.enableFloatingToolbar,
				items: [
					{
						name: 'Push',
						desc: 'Push to Google Drive.',
						control: {
							type: 'toggle',
							key: 'toolbarPush',
							defaultValue: true,
						},
					},
					{
						name: 'Pull',
						desc: 'Pull from Google Drive.',
						control: {
							type: 'toggle',
							key: 'toolbarPull',
							defaultValue: false,
						},
					},
					{
						name: 'Fix paths',
						desc: 'Fix Google Drive paths.',
						control: {
							type: 'toggle',
							key: 'toolbarFix',
							defaultValue: false,
						},
					},
					{
						name: 'Reset',
						desc: 'Reset local vault to Google Drive.',
						control: {
							type: 'toggle',
							key: 'toolbarReset',
							defaultValue: false,
						},
					},
				],
			},
			{
				name: 'Access token endpoint',
				desc: 'Service used to exchange the refresh token for a Google access token. The refresh token is sent to this URL. This is just so you can self-host the access token refresher. The code to host the website is available at https://github.com/RichardX366/Obsidian-Google-Drive-website. Defaults to my hosted service at https://ogd-server.richardxiong.com/api/access.',
				control: {
					type: 'text',
					key: 'accessTokenUrl',
					placeholder:
						'https://ogd-server.richardxiong.com/api/access',
					validate: (value: string) => {
						if (!value) return;
						try {
							if (new URL(value).protocol !== 'https:') {
								return 'Access token endpoint must use HTTPS.';
							}
						} catch {
							return 'Enter a valid access token endpoint URL.';
						}
						return;
					},
				},
			},
			{
				name: 'Client ID',
				desc: 'Optional OAuth client ID. When both a client ID and client secret are set, the plugin exchanges refresh tokens directly with Google.',
				control: {
					type: 'text',
					key: 'clientId',
					placeholder: 'Client ID',
				},
			},
			{
				name: 'Client secret',
				desc: 'Optional OAuth client secret. When both a client ID and client secret are set, the plugin exchanges refresh tokens directly with Google.',
				control: {
					type: 'text',
					key: 'clientSecret',
					placeholder: 'Client secret',
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
		if (key === 'enableFloatingToolbar') {
			this.plugin.refreshFloatingToolbar();
			this.update();
			return;
		}

		const actionKeys: (keyof PluginSettings)[] = [
			'toolbarPush',
			'toolbarPull',
			'toolbarFix',
			'toolbarReset',
		];
		if (actionKeys.includes(key as keyof PluginSettings)) {
			if (!actionKeys.some((k) => this.plugin.settings[k])) {
				// Don't let the user disable the last remaining action.
				(this.plugin.settings[key as keyof PluginSettings] as boolean) =
					true;
				await this.plugin.saveSettings();
				this.update();
				new Notice('Keep at least one toolbar action enabled.');
			}
			this.plugin.refreshFloatingToolbar();
		}
	}
}
