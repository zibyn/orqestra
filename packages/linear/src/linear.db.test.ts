import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// The app's tokens kept in a migrated, throwaway Postgres: TEST_DATABASE_URL is wiped before every test
const url = process.env.TEST_DATABASE_URL;
if (url) process.env.DATABASE_URL = url;
const { db } = await import("@orqestra/db");
const { linearInstallation } = await import("@orqestra/db/schema");
const { encryptSecret } = await import("@orqestra/db/secret");
const { sql } = await import("drizzle-orm");
const { linearAccessToken } = await import("./index.ts");
const { fakeLinear } = await import("./testing.ts");

describe.skipIf(!url)("the Linear app's access token", () => {
	const reset = () => db.execute(sql`truncate linear_installation`);
	beforeEach(reset);
	afterAll(reset);

	const install = (expiresAt: number) =>
		db.insert(linearInstallation).values({
			clientId: "lin-client",
			clientSecret: encryptSecret("client-s3cret"),
			webhookSecret: encryptSecret("hook-s3cret"),
			tokens: encryptSecret(
				JSON.stringify({
					accessToken: "access-0",
					refreshToken: "refresh-0",
					expiresAt,
				}),
			),
			workspace: "Acme",
		});

	it("is the stored one while it is not about to expire", async () => {
		const linear = fakeLinear();
		await install(Date.now() + 3_600_000);
		expect(await linearAccessToken({ fetch: linear.fetch })).toBe("access-0");
		expect(linear.tokenRequests).toEqual([]);
	});

	it("refreshes once when two processes find it expired together, and refreshes with the rotated refresh token next time", async () => {
		const linear = fakeLinear();
		linear.refreshTokens.add("refresh-0");
		await install(Date.now() - 1);
		// slow enough that the second has read the tokens before the first has stored new ones, but for the lock
		const slow: typeof linear.fetch = async (input, init) => {
			await new Promise((r) => setTimeout(r, 200));
			return linear.fetch(input, init);
		};
		const both = await Promise.all([
			linearAccessToken({ fetch: slow }),
			linearAccessToken({ fetch: slow }),
		]);
		expect(both).toEqual(["access-1", "access-1"]);
		expect(linear.tokenRequests).toEqual([
			{
				grant_type: "refresh_token",
				refresh_token: "refresh-0",
				client_id: "lin-client",
				client_secret: "client-s3cret",
			},
		]);

		// a day on, access-1 has expired; refresh-0 is spent, so only the stored refresh-1 refreshes
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(Date.now() + 25 * 3_600_000);
		try {
			expect(await linearAccessToken({ fetch: linear.fetch })).toBe("access-2");
		} finally {
			vi.useRealTimers();
		}
	});

	it("is undefined until the app is installed, and throws when Linear refuses the refresh", async () => {
		const linear = fakeLinear();
		expect(await linearAccessToken({ fetch: linear.fetch })).toBeUndefined();
		await install(Date.now() - 1);
		await expect(linearAccessToken({ fetch: linear.fetch })).rejects.toThrow(
			/400/,
		);
	});
});
