import ky, { Hooks } from "ky";
import ObsidianGoogleDrive from "main";
import { Notice } from "obsidian";
import { checkConnection } from "./drive";

const getHooks = (t: ObsidianGoogleDrive): Hooks => ({
	beforeRequest: [
		async (request) => {
			if (t.accessToken.token) {
				if (t.accessToken.expiresAt - Date.now() < 60000) {
					await refreshAccessToken(t);
				}
				request.headers.set(
					"Authorization",
					`Bearer ${t.accessToken.token}`
				);
			}
			return request;
		},
	],
	afterResponse: [
		async (request, options, response) => {
			if (!response.ok) {
				new Notice(`Error: ${await response.text()}`);
				return new Response();
			}
			return response;
		},
	],
});

export const getDriveKy = (t: ObsidianGoogleDrive) => {
	return ky.extend({
		prefixUrl: "https://www.googleapis.com",
		hooks: getHooks(t),
		timeout: 120_000,
	});
};

export const refreshAccessToken = async (t: ObsidianGoogleDrive) => {
	try {
		const { expires_in, access_token } = await ky
			.post("https://ogd.richardxiong.com/api/access", {
				json: { refresh_token: t.settings.refreshToken },
			})
			.json<any>();

		t.accessToken = {
			token: access_token,
			expiresAt: Date.now() + expires_in * 1000,
		};
		return t.accessToken;
	} catch (e: any) {
		if (!(await checkConnection())) {
			return new Notice(
				"Something is wrong with your internet connection, so we could not fetch a new access token! Once you're back online, please restart Obsidian.",
				0
			);
		}

		// Only treat the refresh token as invalid on a genuine auth failure.
		// Transient errors (5xx, timeouts, rate limits) must NOT wipe the token,
		// otherwise the user is forced to re-add it later. A revoked/expired
		// refresh token surfaces as 400 (invalid_grant) / 401 / 403.
		const status = e?.response?.status;
		if (status !== 400 && status !== 401 && status !== 403) {
			return new Notice(
				"Could not fetch a new access token due to a temporary error. Your token is still saved — please try again in a moment or restart Obsidian.",
				0
			);
		}

		t.settings.refreshToken = "";
		t.accessToken = {
			token: "",
			expiresAt: 0,
		};

		new Notice(
			"Something is wrong with your refresh token, please restart Obsidian and then reset it.",
			0
		);
		await t.saveSettings();
		return;
	}
};
