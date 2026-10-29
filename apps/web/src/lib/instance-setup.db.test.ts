import { beforeEach, describe, expect, it } from "vitest";
import { bootstrapDefaultAdmin } from "#/lib/identity";

// Needs a migrated, throwaway Postgres: TEST_DATABASE_URL is wiped before every test
const url = process.env.TEST_DATABASE_URL;
if (url) process.env.DATABASE_URL = url;
const { db } = await import("@orqestra/db");
const { auth, isSetupCompleted, setupInstance } = await import("#/lib/auth");
const { sql } = await import("drizzle-orm");

describe.skipIf(!url)("Instance Setup (Postgres)", () => {
	beforeEach(async () => {
		await db.execute(sql`truncate "user", instance_settings cascade`);
	});

	it("creates exactly one Default Admin when /setup and env bootstrap race", async () => {
		const results = await Promise.all([
			setupInstance({ email: "setup@x.io", password: "password1" }),
			bootstrapDefaultAdmin(
				{ ADMIN_EMAIL: "env@x.io", ADMIN_PASSWORD: "password2" },
				setupInstance,
			),
			setupInstance({ email: "again@x.io", password: "password3" }),
		]);
		expect(results.filter(Boolean)).toHaveLength(1);
		const admins = await db.query.user.findMany();
		expect(admins.map((u) => u.role)).toEqual(["admin"]);
		expect(await isSetupCompleted()).toBe(true);
	});

	it("stays completed even once no Admin is left", async () => {
		await setupInstance({ email: "a@x.io", password: "password1" });
		await db.execute(sql`delete from "user"`);
		expect(
			await setupInstance({ email: "b@x.io", password: "password1" }),
		).toBe(false);
		expect(await isSetupCompleted()).toBe(true);
	});

	it("does not let an Admin demote themselves", async () => {
		await setupInstance({ email: "a@x.io", password: "password1" });
		const { headers, response } = await auth.api.signInEmail({
			body: { email: "a@x.io", password: "password1" },
			returnHeaders: true,
		});
		const cookie = new Headers({ cookie: headers.get("set-cookie") ?? "" });
		await expect(
			auth.api.setRole({
				body: { userId: response.user.id, role: "user" },
				headers: cookie,
			}),
		).rejects.toMatchObject({ statusCode: 400 });
		await expect(
			auth.api.adminUpdateUser({
				body: { userId: response.user.id, data: { role: "user" } },
				headers: cookie,
			}),
		).rejects.toMatchObject({ statusCode: 400 });
	});
});
