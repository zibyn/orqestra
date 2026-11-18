import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";

// The app's tokens kept in a migrated, throwaway Postgres: TEST_DATABASE_URL is wiped before every test
const url = process.env.TEST_DATABASE_URL;
if (url) process.env.DATABASE_URL = url;
const { db } = await import("@orqestra/db");
const { integrationInstallation } = await import("@orqestra/db/schema");
const { decryptSecret, encryptSecret } = await import("@orqestra/db/secret");
const { sql } = await import("drizzle-orm");
const { createPostgresBackend, Queue } = await import("bullmq");
const { GrantRefused, accessToken, installationStatus, serveTokenRefresh } =
	await import("./installation.ts");
const { linear: source } = await import("./linear/index.ts");
const { fakeLinear } = await import("./testing.ts");

async function waitFor<T>(read: () => T | Promise<T>, ok: (v: T) => boolean) {
	for (let i = 0; i < 200; i++) {
		const v = await read();
		if (ok(v)) return v;
		await new Promise((r) => setTimeout(r, 50));
	}
	throw new Error("timed out");
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const needsReinstall = async () =>
	(await installationStatus(source))?.needsReinstall;

describe.skipIf(!url)("the Linear app's access token", () => {
	const reset = () => db.execute(sql`truncate integration_installation`);
	beforeEach(reset);
	afterAll(reset);

	const install = (expiresAt: number) =>
		db.insert(integrationInstallation).values({
			kind: "linear",
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
		expect(await accessToken(source, { fetch: linear.fetch })).toBe("access-0");
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
			accessToken(source, { fetch: slow }),
			accessToken(source, { fetch: slow }),
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
			expect(await accessToken(source, { fetch: linear.fetch })).toBe(
				"access-2",
			);
		} finally {
			vi.useRealTimers();
		}
	});

	it("is undefined until the app is installed, and throws when Linear refuses the refresh, marking the installation for a reinstall", async () => {
		const linear = fakeLinear();
		expect(await accessToken(source, { fetch: linear.fetch })).toBeUndefined();
		await install(Date.now() - 1);
		expect(await needsReinstall()).toBe(false);
		// refresh-0 is one Linear never issued, or has revoked
		await expect(accessToken(source, { fetch: linear.fetch })).rejects.toThrow(
			GrantRefused,
		);
		expect(await needsReinstall()).toBe(true);
	});

	it("is not marked for a reinstall when Linear is only unreachable or failing, and is unmarked by the next refresh that succeeds", async () => {
		const linear = fakeLinear();
		linear.refreshTokens.add("refresh-0");
		await install(Date.now() - 1);
		const down = async () => new Response("unavailable", { status: 503 });
		const error = await accessToken(source, { fetch: down }).catch((e) => e);
		expect(error).toBeInstanceOf(Error);
		expect(error).not.toBeInstanceOf(GrantRefused);
		expect(await needsReinstall()).toBe(false);

		// the client secret Orqestra holds is not the app's, until the Admin saves the right one
		linear.clientSecret = "rotated";
		await expect(accessToken(source, { fetch: linear.fetch })).rejects.toThrow(
			GrantRefused,
		);
		expect(await needsReinstall()).toBe(true);
		linear.clientSecret = "client-s3cret";
		expect(await accessToken(source, { fetch: linear.fetch })).toBe("access-1");
		expect(await needsReinstall()).toBe(false);
	});
});

describe.skipIf(!url)(
	"the worker's schedule for the Linear app's tokens",
	() => {
		const reset = () => db.execute(sql`truncate integration_installation`);
		let worker: Awaited<ReturnType<typeof serveTokenRefresh>> | undefined;
		beforeEach(reset);
		afterEach(async () => {
			await worker?.close();
			worker = undefined;
			// the next test's schedule starts as a first deploy's does, checking at once
			const queue = new Queue(
				"linear-tokens",
				{ connection: { connectionString: url as string } },
				createPostgresBackend,
			);
			await queue.obliterate({ force: true });
			await queue.close();
		});
		afterAll(reset);

		const install = (expiresAt: number) =>
			db.insert(integrationInstallation).values({
				kind: "linear",
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
		/** The stored access token's expiry moved to the past, as a day after its refresh. */
		const expire = async () => {
			const [row] = await db.select().from(integrationInstallation);
			const tokens = JSON.parse(decryptSecret(row.tokens ?? "") ?? "");
			await db.update(integrationInstallation).set({
				tokens: encryptSecret(
					JSON.stringify({ ...tokens, expiresAt: Date.now() - 1 }),
				),
			});
		};
		/** Every row of BullMQ's tables, as text. */
		const queueText = async () => {
			const tables = await db.execute<{ name: string }>(
				sql`select table_name as name from information_schema.tables where table_schema = 'bullmq'`,
			);
			let text = "";
			for (const { name } of tables.rows) {
				const rows = await db.execute(
					sql`select t::text as row from ${sql.identifier("bullmq")}.${sql.identifier(name)} t`,
				);
				text += rows.rows.map((r) => r.row).join("\n");
			}
			return text;
		};
		const refreshes = (linear: ReturnType<typeof fakeLinear>) =>
			linear.tokenRequests.map((r) => r.refresh_token);

		it("refreshes the tokens on its own when they are due, with no Agent Session asking, and not before", async () => {
			const linear = fakeLinear();
			linear.refreshTokens.add("refresh-0");
			await install(Date.now() - 1);
			worker = await serveTokenRefresh(source, {
				every: 200,
				fetch: linear.fetch,
			});
			await waitFor(
				() => refreshes(linear),
				(r) => r.length === 1,
			);
			// several checks on, the new access token is not yet due
			await sleep(1000);
			expect(refreshes(linear)).toEqual(["refresh-0"]);

			await expire();
			await waitFor(
				() => refreshes(linear),
				(r) => r.length === 2,
			);
			expect(refreshes(linear)).toEqual(["refresh-0", "refresh-1"]);
			expect(await accessToken(source, { fetch: linear.fetch })).toBe(
				"access-2",
			);
			expect(linear.tokenRequests).toHaveLength(2);
			expect(await needsReinstall()).toBe(false);
			// the jobs left no token in the queue's tables
			const queued = await queueText();
			expect(queued).toContain("linear-tokens");
			for (const token of ["access-1", "access-2", "refresh-1", "refresh-2"])
				expect(queued).not.toContain(token);
		});

		it("refreshes once when an Agent Session's event needs the token while the scheduled check is refreshing it", async () => {
			const linear = fakeLinear();
			linear.refreshTokens.add("refresh-0");
			await install(Date.now() - 1);
			let refreshing!: () => void;
			const inFlight = new Promise<void>((r) => {
				refreshing = r;
			});
			const scheduled: typeof linear.fetch = async (input, init) => {
				if (String(input).endsWith("/oauth/token")) {
					refreshing();
					await sleep(300);
				}
				return linear.fetch(input, init);
			};
			const serving = await serveTokenRefresh(source, {
				every: 60_000,
				fetch: scheduled,
			});
			worker = serving;
			await inFlight;
			const checked = new Promise((r) => {
				serving.once("completed", r);
				serving.once("failed", r);
			});
			expect(await accessToken(source, { fetch: linear.fetch })).toBe(
				"access-1",
			);
			await checked;
			expect(refreshes(linear)).toEqual(["refresh-0"]);
			expect(await needsReinstall()).toBe(false);
		});

		it("marks the installation for a reinstall when Linear refuses the scheduled refresh", async () => {
			const linear = fakeLinear();
			// refresh-0 lapsed: Linear no longer knows it
			await install(Date.now() - 1);
			worker = await serveTokenRefresh(source, {
				every: 60_000,
				fetch: linear.fetch,
			});
			await waitFor(needsReinstall, Boolean);
			expect(refreshes(linear)).toEqual(["refresh-0"]);
			expect((await installationStatus(source))?.workspace).toBe("Acme");
		});
	},
);
