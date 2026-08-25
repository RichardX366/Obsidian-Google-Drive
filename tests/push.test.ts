import { describe, expect, it, vi } from 'vitest';

vi.mock('obsidian', () => {
	class Element {
		createEl() {
			return new Element();
		}
		createDiv() {
			return new Element();
		}
		createSpan() {
			return new Element();
		}
		setText() {}
		addClass() {}
		empty() {}
		append() {}
	}
	class Modal {
		app: unknown;
		contentEl = new Element();
		constructor(app: unknown) {
			this.app = app;
		}
		setTitle() {}
		open() {
			const confirm = buttons.find((button) => button.text === 'Confirm');
			void confirm?.click?.();
		}
		close() {
			(this as { onClose?: () => void }).onClose?.();
		}
	}
	const buttons: { text?: string; click?: () => void | Promise<void> }[] = [];
	class Setting {
		constructor(_element: unknown) {}
		addButton(configure: (button: unknown) => void) {
			const state: { text?: string; click?: () => void | Promise<void> } = {};
			const button = {
				setButtonText(text: string) {
					state.text = text;
					return button;
				},
				setCta: () => button,
				setDisabled: () => button,
				onClick(click: () => void | Promise<void>) {
					state.click = click;
					return button;
				},
			};
			configure(button);
			buttons.push(state);
			return this;
		}
	}
	class TFile {
		path: string;
		name: string;
		parent?: { path: string };
		constructor(path = '', parent?: { path: string }) {
			this.path = path;
			this.name = path.split('/').at(-1) ?? path;
			this.parent = parent;
		}
	}
	class TFolder extends TFile {}
	return {
		Modal,
		Notice: class {},
		Setting,
		TFile,
		TFolder,
		setIcon: vi.fn(),
		requestUrl: vi.fn(),
		TAbstractFile: class {},
	};
});

import { TFile, TFolder } from 'obsidian';
import { ConfirmUndoModal, push } from '../helpers/push';

describe('push', () => {
	it('does nothing while another sync is running', async () => {
		const plugin = { syncing: true, startSync: vi.fn() };

		await push(plugin as never);

		expect(plugin.startSync).not.toHaveBeenCalled();
	});

	it('pushes creates, modifications, and deletions as one complete sync', async () => {
		const root = { path: '' };
		const folder = new TFolder();
		const created = new TFile();
		const modified = new TFile();
		Object.assign(folder, { path: 'folder', name: 'folder', parent: root });
		Object.assign(created, {
			path: 'folder/new.md',
			name: 'new.md',
			parent: folder,
		});
		Object.assign(modified, {
			path: 'changed.md',
			name: 'changed.md',
			parent: root,
		});
		const files = new Map<string, TFile | TFolder>([
			[folder.path, folder],
			[created.path, created],
			[modified.path, modified],
		]);
		const syncNotice = { setMessage: vi.fn(), hide: vi.fn() };
		const drive = {
			searchFiles: vi
				.fn()
				.mockResolvedValueOnce([])
				.mockResolvedValueOnce([]),
			getChanges: vi.fn(async () => []),
			batchDelete: vi.fn(async () => true),
			createFolder: vi.fn(async () => 'folder-id'),
			uploadFile: vi.fn(async () => 'created-id'),
			updateFile: vi.fn(async () => 'updated-id'),
			getConfigFilesToSync: vi.fn(async () => []),
		};
		const plugin = {
			syncing: false,
			app: {
				vault: {
					configDir: '.config',
					adapter: { exists: vi.fn(async () => true) },
					getAbstractFileByPath: vi.fn((path: string) => files.get(path)),
					getFileByPath: vi.fn((path: string) => files.get(path)),
					readBinary: vi.fn(async () => new ArrayBuffer(1)),
				},
			},
			accessToken: { token: 'access', expiresAt: Date.now() + 3_600_000 },
			settings: {
				operations: {
					'deleted.md': 'delete',
					folder: 'create',
					'folder/new.md': 'create',
					'changed.md': 'modify',
				},
				driveIdToPath: {
					'deleted-id': 'deleted.md',
					'changed-id': 'changed.md',
					'data-id': '.config/plugins/google-drive-sync/data.json',
				},
				lastSyncedAt: 0,
				changesToken: 'changes',
			},
			drive,
			startSync: vi.fn(async () => syncNotice),
			endSync: vi.fn(async () => {
				plugin.syncing = false;
				return true;
			}),
			abortSync: vi.fn(),
		};

		await push(plugin as never);

		expect(drive.batchDelete).toHaveBeenCalledWith(['deleted-id']);
		expect(drive.createFolder).toHaveBeenCalled();
		expect(drive.uploadFile).toHaveBeenCalled();
		expect(drive.updateFile).toHaveBeenCalledWith(
			'changed-id',
			expect.any(Blob),
			expect.any(Object),
		);
		expect(plugin.settings.operations).toEqual({});
		expect(plugin.endSync).toHaveBeenCalledWith(syncNotice, false);
	});
});

describe('ConfirmUndoModal', () => {
	it('undoes a local create by trashing the created file', async () => {
		const file = { path: 'note.md' };
		const modal = Object.create(
			ConfirmUndoModal.prototype,
		) as ConfirmUndoModal;
		Object.assign(modal, {
			app: { vault: { getAbstractFileByPath: vi.fn(() => file) } },
			t: { deleteFile: vi.fn(async () => undefined) },
		});

		await modal.handleCreate('note.md');

		expect(modal.t.deleteFile).toHaveBeenCalledWith(file);
	});
});
