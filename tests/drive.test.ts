import { beforeEach, describe, expect, it, vi } from 'vitest';

const requestUrl = vi.hoisted(() => vi.fn());

vi.mock('obsidian', () => ({
	Notice: class {},
	requestUrl,
	TAbstractFile: class {},
	TFolder: class {},
}));

import { getDriveClient, splitPath, unSplitPath } from '../helpers/drive';

const createPlugin = () =>
	({
		accessToken: { token: 'access-token', expiresAt: Date.now() + 3_600_000 },
		app: { vault: { getName: () => 'Test vault' } },
		settings: { refreshToken: 'refresh-token' },
	}) as never;

describe('Drive path properties', () => {
	it('round-trips paths longer than a Drive property value', () => {
		const path = `${'folder/'.repeat(20)}note.md`;

		expect(unSplitPath(splitPath(path))).toBe(path);
		expect(
			Object.values(splitPath(path)).every((part) => part.length <= 100),
		).toBe(true);
	});
});

describe('Drive batch deletion', () => {
	beforeEach(() => {
		requestUrl.mockReset();
		requestUrl.mockImplementation(
			async ({ body }: { body?: string | ArrayBuffer }) => {
				const requestBody = typeof body === 'string' ? body : '';
				const requestCount = requestBody.match(/^DELETE /gm)?.length ?? 0;
				return {
					status: 200,
					headers: {},
					arrayBuffer: new ArrayBuffer(0),
					json: {},
					text: Array.from(
						{ length: requestCount },
						() => 'HTTP/1.1 204 No Content',
					).join('\r\n'),
				};
			},
		);
	});

	it('sends raw multipart/mixed requests instead of FormData', async () => {
		const drive = getDriveClient(createPlugin());

		await expect(drive.batchDelete(['file-1', 'file-2'])).resolves.toBe(
			true,
		);

		const request = requestUrl.mock.calls[0]?.[0] as {
			body: string;
			headers: Record<string, string>;
		};
		const boundary = request.headers['Content-Type']?.split('boundary=')[1];

		expect(boundary).toBeTruthy();
		expect(request.body).toContain(`--${boundary}`);
		expect(request.body).toContain('Content-Type: application/http');
		expect(request.body).toContain(
			'DELETE /drive/v3/files/file-1 HTTP/1.1',
		);
		expect(request.body).not.toContain('Content-Disposition: form-data');
		expect(request.body).toMatch(new RegExp(`--${boundary}--\\r\\n$`));
	});

	it('splits more than 100 deletions into multiple requests', async () => {
		const drive = getDriveClient(createPlugin());
		const ids = Array.from({ length: 101 }, (_, index) => `file-${index}`);

		await expect(drive.batchDelete(ids)).resolves.toBe(true);

		const firstRequest = requestUrl.mock.calls[0]?.[0] as
			| { body?: unknown }
			| undefined;
		const secondRequest = requestUrl.mock.calls[1]?.[0] as
			| { body?: unknown }
			| undefined;
		const firstBody =
			typeof firstRequest?.body === 'string' ? firstRequest.body : '';
		const secondBody =
			typeof secondRequest?.body === 'string' ? secondRequest.body : '';

		expect(requestUrl).toHaveBeenCalledTimes(2);
		expect(firstBody.match(/^DELETE /gm)).toHaveLength(100);
		expect(secondBody.match(/^DELETE /gm)).toHaveLength(1);
	});

	it('fails when any nested deletion fails', async () => {
		requestUrl.mockResolvedValueOnce({
			status: 200,
			headers: {},
			arrayBuffer: new ArrayBuffer(0),
			json: {},
			text: [
				'HTTP/1.1 204 No Content',
				'HTTP/1.1 404 Not Found',
			].join('\r\n'),
		});
		const drive = getDriveClient(createPlugin());

		await expect(
			drive.batchDelete(['file-1', 'missing-file']),
		).resolves.toBeUndefined();
	});
});
