import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { OrqestraConfig } from "@orqestra/config";
import { createConversations } from "@orqestra/conversations";
import { db } from "@orqestra/db";
import { createApp, type User } from "./app.ts";

// Needs a migrated, throwaway Postgres: TEST_DATABASE_URL, wiped before every test (see test-env.ts)
const url = process.env.TEST_DATABASE_URL;

const conversations = createConversations({
	config: async () => ({}) as OrqestraConfig,
	skillFiles: async () => [],
});
const ada: User = { id: "ada", name: "Ada", admin: false };

const app = (user: User | null) => (method: string, body?: unknown) =>
	createApp({
		session: async () => ({ user, cookies: [] }),
		auth: () => new Response(),
		conversations,
	}).handle(
		new Request(
			`http://localhost/api/push${method === "GET" ? "" : "/subscriptions"}`,
			{
				method,
				headers: { "content-type": "application/json" },
				body: body === undefined ? undefined : JSON.stringify(body),
			},
		),
	);
const browser = {
	endpoint: "https://fcm.googleapis.com/fcm/send/ada",
	keys: { p256dh: "p", auth: "a" },
};

describe.skipIf(!url)("Alert subscriptions through the api", () => {
	beforeEach(async () => {
		await db.$client.query("truncate push_subscription");
	});
	afterEach(() => {
		delete process.env.VAPID_PUBLIC_KEY;
	});

	it("offers the VAPID public key only when the instance has VAPID keys", async () => {
		expect(await (await app(ada)("GET")).json()).toEqual({ publicKey: null });
		Object.assign(process.env, {
			VAPID_PUBLIC_KEY: "public",
			VAPID_PRIVATE_KEY: "private",
			VAPID_SUBJECT: "mailto:admin@example.com",
		});
		expect(await (await app(ada)("GET")).json()).toEqual({
			publicKey: "public",
		});
	});

	it("saves and forgets the User's browser; refuses the signed-out and endpoints that are no push service's https URL", async () => {
		expect((await app(null)("PUT", browser)).status).toBe(401);
		for (const endpoint of [
			"http://fcm.googleapis.com/fcm/send/ada",
			"https://10.0.0.1/x",
			"https://localhost/x",
			"https://fcm.googleapis.com.evil.example/x",
		])
			expect((await app(ada)("PUT", { ...browser, endpoint })).status).toBe(
				422,
			);
		for (const endpoint of [
			"https://updates.push.services.mozilla.com/wpush/v2/x",
			"https://web.push.apple.com/x",
			"https://wns2-par02p.notify.windows.com/w/?token=x",
		])
			expect((await app(ada)("PUT", { ...browser, endpoint })).status).toBe(
				204,
			);
		await db.$client.query("truncate push_subscription");
		expect((await app(ada)("PUT", browser)).status).toBe(204);
		const saved = await db.$client.query(
			"select user_id from push_subscription",
		);
		expect(saved.rows).toEqual([{ user_id: "ada" }]);
		expect(
			(await app(ada)("DELETE", { endpoint: browser.endpoint })).status,
		).toBe(204);
		expect(
			(await db.$client.query("select 1 from push_subscription")).rows,
		).toEqual([]);
	});
});
