import type ObsidianGoogleDrive from '../main';
import { Notice, requestUrl, RequestUrlResponse } from 'obsidian';

interface RequestOptions {
	body?: BodyInit;
	headers?: Record<string, string>;
	json?: unknown;
}

interface DriveResponse {
	readonly ok: boolean;
	readonly status: number;
	arrayBuffer(): Promise<ArrayBuffer>;
	json<T>(): Promise<T>;
	text(): Promise<string>;
}

const serializeBody = async (
	options: RequestOptions,
): Promise<{ body?: string | ArrayBuffer; contentType?: string }> => {
	if (options.json !== undefined) {
		return {
			body: JSON.stringify(options.json),
			contentType: 'application/json',
		};
	}

	if (options.body === undefined || options.body === null) return {};
	if (typeof options.body === 'string') return { body: options.body };
	if (options.body instanceof ArrayBuffer) return { body: options.body };
	if (ArrayBuffer.isView(options.body)) {
		return {
			body: options.body.buffer.slice(
				options.body.byteOffset,
				options.body.byteOffset + options.body.byteLength,
			),
		};
	}

	const encoded = new Request('https://localhost', {
		method: 'POST',
		body: options.body,
	});
	return {
		body: await encoded.arrayBuffer(),
		contentType: encoded.headers.get('Content-Type') ?? undefined,
	};
};

const toDriveResponse = (response: RequestUrlResponse): DriveResponse => ({
	ok: response.status >= 200 && response.status < 300,
	status: response.status,
	arrayBuffer: async () => response.arrayBuffer,
	json: async <T>() => response.json as T,
	text: async () => response.text,
});

export const getDriveAgent = (t: ObsidianGoogleDrive) => {
	const send = (
		method: string,
		path: string,
		options: RequestOptions = {},
	) => {
		const response = (async () => {
			if (
				t.accessToken.token &&
				t.accessToken.expiresAt - Date.now() < 60_000
			) {
				await refreshAccessToken(t);
			}

			const { body, contentType } = await serializeBody(options);
			const headers = { ...options.headers };
			if (t.accessToken.token) {
				headers.Authorization = `Bearer ${t.accessToken.token}`;
			}

			const result = await requestUrl({
				url: new URL(path, 'https://www.googleapis.com/').toString(),
				method,
				headers,
				body,
				contentType,
				throw: false,
			});

			if (result.status < 200 || result.status >= 300) {
				new Notice(`Error: ${result.text}`);
				throw new Error(
					`Request failed with status ${result.status}: ${result.text}`,
				);
			}
			return toDriveResponse(result);
		})();

		return {
			arrayBuffer: () => response.then((result) => result.arrayBuffer()),
			json: <T>() => response.then((result) => result.json<T>()),
			text: () => response.then((result) => result.text()),
			then: response.then.bind(response),
		};
	};

	return {
		get: (path: string, options?: RequestOptions) =>
			send('GET', path, options),
		post: (path: string, options?: RequestOptions) =>
			send('POST', path, options),
		patch: (path: string, options?: RequestOptions) =>
			send('PATCH', path, options),
		delete: (path: string, options?: RequestOptions) =>
			send('DELETE', path, options),
	};
};

export const refreshAccessToken = async (
	t: ObsidianGoogleDrive,
	refreshToken?: string,
) => {
	try {
		const response = await requestUrl({
			url:
				t.settings.accessTokenUrl ||
				'https://ogd.richardxiong.com/api/access',
			method: 'POST',
			contentType: 'application/json',
			body: JSON.stringify({
				refresh_token: refreshToken || t.settings.refreshToken,
				clientId: t.settings.clientId,
				clientSecret: t.settings.clientSecret,
			}),
			throw: false,
		});

		if ([400, 401, 403].includes(response.status)) {
			new Notice(
				'Your refresh token was rejected. Please add a new refresh token and try again.',
				0,
			);
			return;
		}

		if (response.status < 200 || response.status >= 300) {
			new Notice(
				`Could not refresh your access token (HTTP ${response.status}). Your refresh token was kept; please try again.`,
			);
			return;
		}

		const { expires_in, access_token } = response.json as {
			expires_in: number;
			access_token: string;
		};

		t.accessToken = {
			token: access_token,
			expiresAt: Date.now() + expires_in * 1000,
		};
		return t.accessToken;
	} catch {
		new Notice(
			'Could not refresh your access token. Your refresh token was kept; check your connection and try again.',
		);
	}
	return;
};
