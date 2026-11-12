import { defineConfig } from "vitest/config";

// *.db.test.ts files share and truncate one TEST_DATABASE_URL
export default defineConfig({
	test: {
		fileParallelism: false,
		// a fixed test-only key, so secrets can be stored
		env: {
			ORQESTRA_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
		},
	},
});
