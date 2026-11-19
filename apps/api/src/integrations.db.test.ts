import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import type { Conversations } from "@orqestra/conversations";
import { db } from "@orqestra/db";
import { memoryStore } from "@orqestra/db/store";
import { privateLink } from "@orqestra/integrations";
import { linear } from "@orqestra/integrations/linear";
import { fakeChannel } from "@orqestra/integrations/testing";
import { sql } from "drizzle-orm";
import { createApp } from "./app.ts";
import { createCapabilities } from "./capabilities.ts";

// A chat's app installed by credentials, and a person linked by a private link, through the api, against a migrated, throwaway
// Postgres: TEST_DATABASE_URL is wiped before every test. The chat is a fake in memory, served beside Linear.
const url = process.env.TEST_DATABASE_URL;

const users: Record<string, { id: string; name: string; admin: boolean }> = {
	a1: { id: "a1", name: "Ada", admin: true },
	u1: { id: "u1", name: "Uma", admin: false },
};
let chat = fakeChannel();
const api = createApp({
	config: createCapabilities(db, memoryStore().store),
	session: async (request) => ({
		user: users[request.headers.get("x-user") ?? ""] ?? null,
		cookies: [],
	}),
	auth: () => new Response(null, { status: 404 }),
	conversations: {} as Conversations,
	orqestraUrl: "https://orqestra.example.com",
	// each test's fake, through a source that looks it up
	sources: [
		linear,
		new Proxy({} as typeof chat.source, {
			get: (_, key) => chat.source[key as keyof typeof chat.source],
		}),
	],
});

async function call(
	method: string,
	path: string,
	{ body, user = "a1" }: { body?: unknown; user?: string } = {},
) {
	const response = await api.handle(
		new Request(`http://localhost/api${path}`, {
			method,
			headers: {
				"x-user": user,
				...(body === undefined ? {} : { "content-type": "application/json" }),
			},
			body: body === undefined ? undefined : JSON.stringify(body),
		}),
	);
	const text = await response.text();
	return {
		status: response.status,
		text,
		body: text ? JSON.parse(text) : null,
	};
}

describe.skipIf(!url)("a chat's app and accounts through the api", () => {
	const reset = async () => {
		await db.execute(
			sql`truncate integration_installation, integration_link_sent, "user" cascade`,
		);
		chat = fakeChannel();
	};
	beforeEach(async () => {
		await reset();
		for (const { id, name } of Object.values(users))
			await db.execute(
				sql`insert into "user" (id, name, email, last_active_at) values (${id}, ${name}, ${`${id}@example.com`}, now())`,
			);
	});
	afterAll(reset);

	it("installs it with the credentials the Admin enters, field by field, never sending a secret back", async () => {
		const before = await call("GET", "/email/credentials");
		expect(before.body).toEqual({
			name: "Fake Chat",
			sharedScopes: "listed",
			fields: [
				{
					name: "appId",
					secret: false,
					optional: false,
					value: "",
					readable: false,
				},
				{
					name: "appSecret",
					secret: true,
					optional: false,
					value: "",
					readable: false,
				},
				{
					name: "region",
					secret: false,
					optional: true,
					value: "",
					readable: false,
				},
			],
			installation: null,
			callbackUrl: null,
			webhookUrl: null,
		});
		const missing = await call("PUT", "/email/credentials", {
			body: { appId: " cli-1 " },
		});
		expect(missing.status).toBe(422);
		expect(missing.body.errors).toEqual({
			appSecret: { code: "secret_required" },
		});
		const refused = await call("PUT", "/email/credentials", {
			body: { appId: "cli-1", appSecret: "wrong" },
		});
		expect(refused.body.errors).toEqual({
			"": { code: "credentials_refused", detail: "app secret refused" },
		});

		const put = await call("PUT", "/email/credentials", {
			body: { appId: " cli-1 ", appSecret: "app-s3cret" },
		});
		expect(put.status).toBe(200);
		expect(chat.trades.at(-1)).toEqual({
			appId: "cli-1",
			appSecret: "app-s3cret",
		});
		const after = await call("GET", "/email/credentials");
		expect(after.body.fields).toEqual([
			{
				name: "appId",
				secret: false,
				optional: false,
				value: "cli-1",
				readable: true,
			},
			{
				name: "appSecret",
				secret: true,
				optional: false,
				value: "",
				readable: true,
			},
			{
				name: "region",
				secret: false,
				optional: true,
				value: "",
				readable: false,
			},
		]);
		expect(after.body.installation).toEqual({
			workspace: "Acme Chat",
			defaultAgentId: null,
			scopeRepos: {},
			openScopes: [],
		});
		expect(after.text).not.toContain("app-s3cret");

		const opened = await call("PUT", "/email/conversations", {
			body: {
				defaultAgentId: "general",
				scopeRepos: { "group-1": "acme/web" },
				openScopes: ["group-1"],
			},
		});
		expect(opened.status).toBe(200);
		expect(
			(await call("GET", "/email/credentials")).body.installation.openScopes,
		).toEqual(["group-1"]);
		// leaving the opened scopes out keeps them
		await call("PUT", "/email/conversations", {
			body: { defaultAgentId: "general", scopeRepos: {} },
		});
		expect(
			(await call("GET", "/email/credentials")).body.installation.openScopes,
		).toEqual(["group-1"]);
	});

	it("is for Admins only, answers 404 for another kind of install or a kind it does not serve, and lists what Users connect", async () => {
		expect(
			(await call("GET", "/email/credentials", { user: "u1" })).status,
		).toBe(403);
		expect(
			(await call("PUT", "/email/credentials", { user: "u1", body: {} }))
				.status,
		).toBe(403);
		expect((await call("GET", "/linear/credentials")).status).toBe(404);
		expect((await call("GET", "/email")).status).toBe(404);
		expect((await call("GET", "/nope/credentials")).status).toBe(404);
		expect((await call("POST", "/email/account", { user: "u1" })).status).toBe(
			404,
		);

		await call("PUT", "/email/credentials", {
			body: { appId: "cli-1", appSecret: "app-s3cret" },
		});
		expect((await call("GET", "/integrations", { user: "u1" })).body).toEqual([
			{
				kind: "linear",
				name: "Linear",
				install: "oauth",
				proof: "oauth",
				workspace: null,
				account: null,
			},
			{
				kind: "email",
				name: "Fake Chat",
				install: "credentials",
				proof: "private-link",
				workspace: "Acme Chat",
				account: null,
			},
		]);
		expect(
			(await call("GET", "/integrations", { user: "nobody" })).status,
		).toBe(401);
	});

	it("links the User who confirms a private link, never on opening it, and unlinks them", async () => {
		const link =
			new URL(
				privateLink(
					chat.source,
					{ id: "chat-user-1", name: "Uma C." },
					"https://o.example",
				),
			).searchParams.get("link") ?? "";
		const query = `/integrations/link?${new URLSearchParams({ link })}`;
		const shown = await call("GET", query, { user: "u1" });
		expect(shown.body).toEqual({
			kind: "email",
			integration: "Fake Chat",
			name: "Uma C.",
		});
		expect(
			(await call("GET", "/email/account", { user: "u1" })).body.account,
		).toBeNull();
		expect((await call("GET", query, { user: "nobody" })).status).toBe(401);
		expect(
			(
				await call("POST", "/integrations/link", {
					user: "nobody",
					body: { link },
				})
			).status,
		).toBe(401);
		const bad = await call("POST", "/integrations/link", {
			user: "u1",
			body: { link: "guessed" },
		});
		expect(bad.status).toBe(422);
		expect(bad.body.errors).toEqual({ link: { code: "link_invalid" } });

		const linked = await call("POST", "/integrations/link", {
			user: "u1",
			body: { link },
		});
		expect(linked.body).toEqual({ linked: "email" });
		expect(
			(await call("GET", "/email/account", { user: "u1" })).body.account,
		).toMatchObject({
			name: "Uma C.",
		});
		expect(
			(await call("DELETE", "/email/account", { user: "u1" })).status,
		).toBe(200);
		expect(
			(await call("GET", "/email/account", { user: "u1" })).body.account,
		).toBeNull();
	});
});
