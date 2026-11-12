import { defineConfig } from "vitest/config";

// *.db.test.ts files share and truncate one TEST_DATABASE_URL
export default defineConfig({ test: { fileParallelism: false } });
