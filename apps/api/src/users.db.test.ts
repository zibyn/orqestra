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
async function call(user: User, path: string) {
	const api = createApp({
		session: rememberUsers(async () => ({ user, cookies: [] })),
		auth: () => new Response(null, { status: 404 }),
		conversations: {} as Conversations,
	});
	const response = await api.handle(new Request(`http://localhost/api${path}`));
	return {
		status: response.status,
		body: (await response.json()) as { users: Record<string, unknown>[] },
	};
}

/** The Users page's list, as an Admin sees it, without the Admin's own row. */
const listed = async () =>
	(await call(admin, "/users")).body.users.filter((u) => u.id !== admin.id);

const at = (iso: string) => setSystemTime(new Date(iso));

describe.skipIf(!url)("/api/users", () => {
	const reset = async () => {
		await db.execute(sql`truncate "user"`);
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
		});
	});

	it("lists Users to Admins only", async () => {
		const ada: User = { id: "ada", name: "Ada", admin: false };
		expect((await call(ada, "/users")).status).toBe(403);
	});
});
