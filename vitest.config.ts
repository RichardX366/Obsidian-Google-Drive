import { defineConfig } from 'vitest/config';

export default defineConfig({
	resolve: {
		extensions: ['.ts', '.mts', '.js', '.mjs', '.json'],
	},
	test: {
		clearMocks: true,
		restoreMocks: true,
	},
});
