// *.db.test.ts need a migrated, throwaway Postgres: TEST_DATABASE_URL, wiped before every test
if (process.env.TEST_DATABASE_URL)
	process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
// a fixed test-only key, so API key encryption works
process.env.ORQESTRA_ENCRYPTION_KEY ??=
	"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
