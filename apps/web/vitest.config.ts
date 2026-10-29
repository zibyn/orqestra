import { defineConfig } from "vitest/config";

// Keeps tests off vite.config.ts, whose Start/nitro plugins keep the process alive
export default defineConfig({
	// *.db.test.ts files share and truncate one TEST_DATABASE_URL
	test: { fileParallelism: false },
});
