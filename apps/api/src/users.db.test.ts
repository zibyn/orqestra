import {
	afterAll,
	beforeEach,
	describe,
	expect,
	it,
	setSystemTime,
} from "bun:test";
import type { Conversations } from "@orqestra/conversations";
import { db } from "@orqestra/db";
import { sql } from "drizzle-orm";
import { createApp, type User } from "./app.ts";
import { createCapabilities } from "./capabilities.ts";
import { rememberUsers } from "./users.ts";

// Needs a migrated, throwaway Postgres at TEST_DATABASE_URL (see test-env.ts)
const url = process.env.TEST_DATABASE_URL;

const admin: User = {
	id: "root",
	name: "Root",
	email: "root@x.io",
	admin: true,
};

/** A request to the api as user, its session read the way production reads Polaris'. */
async function call(user: User, path: string, put?: unknown) {
	const api = createApp({
		config: createCapabilities(db),
		session: rememberUsers(async () => ({ user, cookies: [] })),
		auth: () => new Response(null, { status: 404 }),
		conversations: {} as Conversations,
	});
	const response = await api.handle(
		new Request(
			`http://localhost/api${path}`,
			put === undefined
				? {}
				: {
						method: "PUT",
						headers: { "content-type": "application/json" },
						body: JSON.stringify(put),
					},
		),
	);
	return {
		status: response.status,
		body: (await response.json()) as {
			users: Record<string, unknown>[];
			errors: Record<string, unknown>;
		},
	};
}

/** The Users page's list, as an Admin sees it, without the Admin's own row. */
const listed = async () =>
	(await call(admin, "/users")).body.users.filter((u) => u.id !== admin.id);

const at = (iso: string) => setSystemTime(new Date(iso));

describe.skipIf(!url)("/api/users", () => {
	const reset = async () => {
		await db.execute(sql`truncate "user", usage, limits`);
	};
	beforeEach(reset);
	afterAll(async () => {
		setSystemTime();
		await reset();
	});

	it("remembers a User on their first signed-in request", async () => {
		at("2026-01-01T10:00:00Z");
		await call(
			{ id: "ada", name: "Ada", email: "ada@x.io", admin: false },
			"/session",
		);
		expect(await listed()).toEqual([
			{
				id: "ada",
				name: "Ada",
				email: "ada@x.io",
				lastActiveAt: "2026-01-01T10:00:00.000Z",
				spendingLimit: { mode: "default" },
				spent: 0,
			},
		]);
	});

	it("follows a changed name or email", async () => {
		at("2026-01-01T10:00:00Z");
		await call(
			{ id: "ada", name: "Ada", email: "ada@x.io", admin: false },
			"/session",
		);
		await call(
			{ id: "ada", name: "Ada L", email: "ada@x.io", admin: false },
			"/session",
		);
		expect(await listed()).toMatchObject([
			{ name: "Ada L", email: "ada@x.io" },
		]);
		await call({ id: "ada", name: "Ada L", admin: false }, "/session");
		expect(await listed()).toMatchObject([{ name: "Ada L", email: null }]);
	});

	it("moves the last-active time at most hourly", async () => {
		const ada: User = { id: "ada", name: "Ada", admin: false };
		at("2026-01-01T10:00:00Z");
		await call(ada, "/session");
		at("2026-01-01T10:59:00Z");
		await call(ada, "/session");
		expect(await listed()).toMatchObject([
			{ lastActiveAt: "2026-01-01T10:00:00.000Z" },
		]);
		at("2026-01-01T11:01:00Z");
		await call(ada, "/session");
		expect(await listed()).toMatchObject([
			{ lastActiveAt: "2026-01-01T11:01:00.000Z" },
		]);
	});

	it("does not record who is an Admin", async () => {
		at("2026-01-01T10:00:00Z");
		await call(admin, "/session");
		const [row] = (await call(admin, "/users")).body.users;
		expect(row).toEqual({
			id: "root",
			name: "Root",
			email: "root@x.io",
			lastActiveAt: "2026-01-01T10:00:00.000Z",
			spendingLimit: { mode: "default" },
			spent: 0,
		});
	});

	it("lists Users to Admins only", async () => {
		const ada: User = { id: "ada", name: "Ada", admin: false };
		expect((await call(ada, "/users")).status).toBe(403);
		expect(
			(await call(ada, "/users/ada/spending-limit", { mode: "unlimited" }))
				.status,
		).toBe(403);
	});

	it("shows what each User spent this month in the reset time zone", async () => {
		await db.execute(
			sql`insert into limits (id, max_scheduled_tasks_per_user, min_firing_interval, timer_rings_per_user_message, unattended_max_steps, unattended_max_duration, max_subagent_depth, reset_time_zone)
			values (1, 10, 3600, 10, 50, 1800, 2, 'Asia/Shanghai')`,
		);
		const spend = (cost: number, iso: string) =>
			db.execute(
				sql`insert into usage (user_id, provider, model_id, conversation_id, purpose, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost, created_at)
				values ('ada', 'faux', 'faux-1', gen_random_uuid(), 'step', 1, 1, 0, 0, ${cost}, ${iso})`,
			);
		// February began in Shanghai at 16:00 UTC on 31 January
		await spend(10, "2026-01-31 15:59:00");
		await spend(2, "2026-01-31 16:01:00");
		at("2026-01-31T17:00:00Z");
		await call({ id: "ada", name: "Ada", admin: false }, "/session");
		expect(await listed()).toMatchObject([{ id: "ada", spent: 2 }]);
	});

	it("sets a User's own Spending Limit, refusing an ambiguous one", async () => {
		await call({ id: "ada", name: "Ada", admin: false }, "/session");
		const set = (body: unknown, id = "ada") =>
			call(admin, `/users/${id}/spending-limit`, body);
		expect((await set({ mode: "limited", usd: 0 })).status).toBe(200);
		expect(await listed()).toMatchObject([
			{ spendingLimit: { mode: "limited", usd: 0 } },
		]);
		expect((await set({ mode: "unlimited" })).status).toBe(200);
		expect(await listed()).toMatchObject([
			{ spendingLimit: { mode: "unlimited" } },
		]);
		const noAmount = await set({ mode: "limited" });
		expect(noAmount.status).toBe(422);
		expect(Object.keys(noAmount.body.errors)).toEqual(["usd"]);
		expect((await set({ mode: "limited", usd: -1 })).status).toBe(422);
		expect((await set({ mode: "default" })).status).toBe(200);
		expect(await listed()).toMatchObject([
			{ spendingLimit: { mode: "default" } },
		]);
		expect((await set({ mode: "unlimited" }, "nobody")).status).toBe(404);
	});
});
