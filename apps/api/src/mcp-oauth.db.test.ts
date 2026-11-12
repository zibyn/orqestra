import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import type { Conversations } from "@orqestra/conversations";
import { db } from "@orqestra/db";
import { sql } from "drizzle-orm";
import { createApp } from "./app.ts";

// Per-User OAuth MCP Servers through the api, against a migrated, throwaway Postgres: TEST_DATABASE_URL is wiped before every test
const url = process.env.TEST_DATABASE_URL;

const api = createApp({
	session: async () => ({
		user: { id: "a1", name: "Ada", admin: true },
		cookies: [],
	}),
	auth: () => new Response(null, { status: 404 }),
	conversations: {} as Conversations,
});

async function call(method: string, path: string, body?: unknown) {
	const response = await api.handle(
		new Request(`http://localhost/api${path}`, {
			method,
			headers: body === undefined ? {} : { "content-type": "application/json" },
			body: body === undefined ? undefined : JSON.stringify(body),
		}),
	);
	const text = await response.text();
	return { status: response.status, body: text ? JSON.parse(text) : null };
}

// An MCP Server at /mcp that wants a Bearer, with its authorization server at /as; each part can go missing
const fake = {
	resourceMetadata: true,
	pkce: ["S256"] as string[] | undefined,
	paths: [] as string[],
};
const server = Bun.serve({
	port: 0,
	fetch(request): Response {
		const { pathname, origin: base } = new URL(request.url);
		fake.paths.push(pathname);
		if (pathname === "/mcp")
			return new Response(null, {
				status: 401,
				headers: {
					"www-authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`,
				},
			});
		if (
			pathname === "/.well-known/oauth-protected-resource/mcp" &&
			fake.resourceMetadata
		)
			return Response.json({
				resource: `${base}/mcp`,
				authorization_servers: [`${base}/as`],
			});
		// served at the origin too: the pre-2025-06-18 guess must not find it
		if (
			pathname === "/.well-known/oauth-authorization-server/as" ||
			pathname === "/.well-known/oauth-authorization-server"
		)
			return Response.json({
				issuer:
					pathname === "/.well-known/oauth-authorization-server"
						? base
						: `${base}/as`,
				authorization_endpoint: `${base}/as/authorize`,
				token_endpoint: `${base}/as/token`,
				response_types_supported: ["code"],
				code_challenge_methods_supported: fake.pkce,
			});
		return new Response(null, { status: 404 });
	},
});
const base = server.url.origin;

const oauth = {
	id: "github",
	create: true,
	name: "GitHub",
	url: `${base}/mcp`,
	enabled: true,
	headers: [],
};

describe.skipIf(!url)("per-User OAuth MCP Servers through the api", () => {
	const reset = async () => {
		await db.execute(sql`truncate mcp_server cascade`);
		fake.resourceMetadata = true;
		fake.pkce = ["S256"];
		fake.paths = [];
	};
	beforeEach(reset);
	afterAll(async () => {
		await reset();
		server.stop();
	});

	it("refuses an Authorization header beside a pre-registered Client, however it is written", async () => {
		const { body } = await call("POST", "/mcp-servers", {
			...oauth,
			oauthClientId: "orq-client",
			headers: [
				{ name: "X-Tenant", value: "t" },
				{ name: "authorization", value: "Bearer shared" },
			],
		});
		expect(body).toEqual({
			errors: { headers: { code: "header_reserved", header: "authorization" } },
		});
		expect((await call("GET", "/mcp-servers")).body).toEqual([]);
	});

	it("never sends the pre-registered Client Secret back, only whether it is readable", async () => {
		const saved = await call("POST", "/mcp-servers", {
			...oauth,
			oauthClientId: "orq-client",
			oauthClientSecret: "s3cret",
		});
		const listed = await call("GET", "/mcp-servers");
		expect(JSON.stringify([saved.body, listed.body])).not.toContain("s3cret");
		expect(listed.body).toMatchObject([
			{
				id: "github",
				auth: "oauth",
				oauthClientId: "orq-client",
				oauthClientSecret: { readable: true },
			},
		]);
	});

	it("is per-User OAuth when it refuses Orqestra and names its authorization server, tested without listing Tools", async () => {
		const { body } = await call("POST", "/mcp-servers", oauth);
		expect(body).toEqual({
			errors: {},
			test: { ok: true, authorizationServer: `${base}/as` },
		});
		expect((await call("GET", "/mcp-servers")).body).toMatchObject([
			{ auth: "oauth" },
		]);
	});

	it("is shared when it refuses Orqestra without Protected Resource Metadata, never taking the origin for an authorization server", async () => {
		fake.resourceMetadata = false;
		const { body } = await call("POST", "/mcp-servers", oauth);
		expect(body.errors).toEqual({});
		expect(body.test).toMatchObject({ ok: false, reason: "auth" });
		expect(fake.paths).not.toContain("/.well-known/oauth-authorization-server");
		expect((await call("GET", "/mcp-servers")).body).toMatchObject([
			{ auth: "shared" },
		]);
	});

	it("keeps how it is signed in to when it does not answer", async () => {
		await call("POST", "/mcp-servers", oauth);
		const { body } = await call("POST", "/mcp-servers", {
			...oauth,
			create: false,
			url: "http://127.0.0.1:9/mcp",
		});
		expect(body.test).toMatchObject({ ok: false, reason: "unreachable" });
		expect((await call("GET", "/mcp-servers")).body).toMatchObject([
			{ auth: "oauth" },
		]);
	});

	it("fails the test when the authorization server does not say it supports PKCE S256", async () => {
		for (const [id, pkce] of [
			["missing", undefined],
			["plain", ["plain"]],
		] as const) {
			fake.pkce = pkce && [...pkce];
			const { body } = await call("POST", "/mcp-servers", { ...oauth, id });
			expect(body.test).toMatchObject({ ok: false, step: "pkce" });
		}
	});

	it("is shared with an Authorization header, tested by connecting with it", async () => {
		const { body } = await call("POST", "/mcp-servers", {
			...oauth,
			headers: [{ name: "Authorization", value: "Bearer shared" }],
		});
		expect(body.errors).toEqual({});
		expect(body.test).toMatchObject({ ok: false, reason: "auth" });
		expect(fake.paths).not.toContain(
			"/.well-known/oauth-protected-resource/mcp",
		);
		expect((await call("GET", "/mcp-servers")).body).toMatchObject([
			{ auth: "shared", oauthClientId: null, oauthClientSecret: null },
		]);
	});
});
