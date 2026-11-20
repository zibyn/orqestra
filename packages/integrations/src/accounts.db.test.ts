import { afterAll, beforeEach, describe, expect, it } from "vitest";

// Linking an Integration Account by the User's MCP Connection token, in a migrated, throwaway Postgres: TEST_DATABASE_URL is wiped
// before every test. GitHub is a fake in memory.
const url = process.env.TEST_DATABASE_URL;
if (url) process.env.DATABASE_URL = url;
const { db } = await import("@orqestra/db");
const { integrationInstallation } = await import("@orqestra/db/schema");
const { encryptSecret } = await import("@orqestra/db/secret");
const { sql } = await import("drizzle-orm");
const { linkByConnection } = await import("./index.ts");
const { github } = await import("./github/index.ts");
const { fakeGitHub } = await import("./github/testing.ts");

const reset = () =>
	db.execute(sql`truncate integration_installation, "user" cascade`);

describe.skipIf(!url)("linking an account by a Connection", () => {
	beforeEach(async () => {
		await reset();
		await db.execute(
			sql`insert into "user" (id, name, email, last_active_at) values ('u1', 'u1', 'u1@example.com', now())`,
		);
	});
	afterAll(reset);

	const accounts = async () =>
		(
			await db.execute(
				sql`select external_id, user_id, name from integration_account`,
			)
		).rows;

	it("links the person a token of the app's own client names, and no one by another client's", async () => {
		const gh = fakeGitHub();
		await db.insert(integrationInstallation).values({
			kind: "github",
			credentials: encryptSecret(JSON.stringify(gh.credentials)),
		});
		gh.userTokens.add("user-token");

		const other = { clientId: "Iv1.other", accessToken: "user-token" };
		expect(await linkByConnection(github, "u1", other, gh.fetch)).toBe(false);
		expect(await accounts()).toEqual([]);

		const own = {
			clientId: gh.credentials.clientId,
			accessToken: "user-token",
		};
		expect(await linkByConnection(github, "u1", own, gh.fetch)).toBe(true);
		expect(await accounts()).toEqual([
			{ external_id: "4242", user_id: "u1", name: "octocat" },
		]);
		// the Connection keeps its token: linking revokes nothing
		expect(gh.userTokens.has("user-token")).toBe(true);
	});
});
