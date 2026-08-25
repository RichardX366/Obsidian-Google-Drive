import { describe, expect, it, vi } from 'vitest';

vi.mock('obsidian', () => {
	class Element {}
	const buttons: { text?: string; click?: () => void | Promise<void> }[] = [];
	class Modal {
		app: unknown;
		contentEl = new Element();
		constructor(app: unknown) {
			this.app = app;
		}
		setTitle() {}
		setContent() {}
		open() {
			const resetButton = buttons.find((button) => button.text === 'Reset!');
			void resetButton?.click?.();
		}
		close() {
			(this as { onClose?: () => void }).onClose?.();
		}
	}
	class Setting {
		constructor(_element: unknown) {}
		addButton(configure: (button: unknown) => void) {
			const state: { text?: string; click?: () => void | Promise<void> } = {};
			const button = {
				setButtonText(text: string) {
					state.text = text;
					return button;
				},
				setDestructive: () => button,
				setCta: () => button,
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
	class TAbstractFile {
		path = '';
	}
	class TFile extends TAbstractFile {}
	return {
		Modal,
		Notice: class {},
		Setting,
		TAbstractFile,
		TFile,
		TFolder: class extends TAbstractFile {},
		requestUrl: vi.fn(),
	};
});

import { TFile } from 'obsidian';
import { ConfirmResetModal, reset } from '../helpers/reset';

describe('reset', () => {
	it('does nothing while another sync is running', async () => {
		const plugin = { syncing: true, startSync: vi.fn() };

		await reset(plugin as never);

		expect(plugin.startSync).not.toHaveBeenCalled();
	});

	it('fully restores created, modified, and deleted files from Drive', async () => {
		const created = new TFile();
		const modified = new TFile();
		Object.assign(created, { path: 'created.md' });
		Object.assign(modified, { path: 'modified.md' });
		const files = new Map([
			[created.path, created],
			[modified.path, modified],
		]);
		const content = new ArrayBuffer(3);
		const syncNotice = { setMessage: vi.fn(), hide: vi.fn() };
		const drive = {
			searchFiles: vi
				.fn()
				.mockResolvedValueOnce([])
				.mockResolvedValueOnce([
					{
						id: 'deleted-id',
						mimeType: 'text/markdown',
						properties: { path: 'deleted.md' },
						modifiedTime: '2025-01-01T00:00:00.000Z',
					},
				]),
			getChanges: vi.fn(async () => []),
			deleteFilesMinimumOperations: vi.fn(async () => undefined),
			getFile: vi.fn(() => ({
				arrayBuffer: vi.fn(async () => content),
			})),
			getFileMetadata: vi.fn(async () => ({
				modifiedTime: '2025-02-01T00:00:00.000Z',
			})),
		};
		const plugin = {
			syncing: false,
			app: {
				vault: {
					adapter: {
						exists: vi.fn(async () => false),
					},
					getAbstractFileByPath: vi.fn((path: string) => files.get(path)),
					getFileByPath: vi.fn((path: string) => files.get(path)),
				},
			},
			accessToken: { token: 'access', expiresAt: Date.now() + 3_600_000 },
			settings: {
				operations: {
					'created.md': 'create',
					'modified.md': 'modify',
					'deleted.md': 'delete',
				},
				driveIdToPath: {
					'modified-id': 'modified.md',
					'deleted-id': 'deleted.md',
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
			deleteFile: vi.fn(),
			modifyFile: vi.fn(async () => undefined),
			createFile: vi.fn(async () => undefined),
			createFolder: vi.fn(async () => undefined),
		};

		await reset(plugin as never);

		expect(drive.deleteFilesMinimumOperations).toHaveBeenCalledWith([created]);
		expect(plugin.modifyFile).toHaveBeenCalledWith(
			modified,
			content,
			'2025-02-01T00:00:00.000Z',
		);
		expect(plugin.createFile).toHaveBeenCalledWith(
			'deleted.md',
			content,
			'2025-01-01T00:00:00.000Z',
		);
		expect(plugin.settings.operations).toEqual({});
		expect(plugin.endSync).toHaveBeenCalledWith(syncNotice);
	});

	it('resolves a dismissed confirmation as false', () => {
		const proceed = vi.fn();
		const modal = Object.create(
			ConfirmResetModal.prototype,
		) as ConfirmResetModal;
		Object.assign(modal, { proceed });

		modal.onClose();

		expect(proceed).toHaveBeenCalledWith(false);
	});
});
