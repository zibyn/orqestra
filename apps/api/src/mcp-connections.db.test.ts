import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { config } from "@orqestra/config/live";
import type { Conversations } from "@orqestra/conversations";
import { db } from "@orqestra/db";
import { user as userRecord } from "@orqestra/db/schema";
import { fakeAuthorizationServer } from "@orqestra/tools/testing";
import { sql } from "drizzle-orm";
import { createApp } from "./app.ts";

// A User's Connections through the api, against a migrated, throwaway Postgres: TEST_DATABASE_URL is wiped before every test.
// The MCP Server and its authorization server are fakes behind the injected fetch.
const url = process.env.TEST_DATABASE_URL;

const users: Record<string, { id: string; name: string; admin: boolean }> = {
	a1: { id: "a1", name: "Ada", admin: true },
	u1: { id: "u1", name: "Uma", admin: false },
	u2: { id: "u2", name: "Ugo", admin: false },
	u3: { id: "u3", name: "Ida", admin: false },
};

let as = fakeAuthorizationServer();
const apps = {
	https: "https://orqestra.example.com",
	http: "http://orqestra.internal",
};
const app = (orqestraUrl: string) =>
	createApp({
		session: async (request) => ({
			user: users[request.headers.get("x-user") ?? ""] ?? null,
			cookies: [],
		}),
		auth: () => new Response(null, { status: 404 }),
		conversations: {
			deletingMcpServer: async () => {},
		} as unknown as Conversations,
		orqestraUrl,
		// looked up per request, so each test's fake is used
		fetch: (input, init) => as.fetch(input, init),
	});
const api = { https: app(apps.https), http: app(apps.http) };

async function call(
	user: string,
	method: string,
	path: string,
	{ body, on = "https" }: { body?: unknown; on?: keyof typeof api } = {},
) {
	const response = await api[on].handle(
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
		location: response.headers.get("location"),
		body: text ? JSON.parse(text) : null,
	};
}

const github = {
	id: "github",
	create: true,
	name: "GitHub",
	url: "https://mcp.example.com/mcp",
	enabled: true,
	auth: "oauth" as "shared" | "oauth",
	headers: [],
};
const save = async (
	server: Partial<typeof github> & Record<string, unknown>,
) => {
	const { body } = await call("a1", "POST", "/mcp-servers", {
		body: { ...github, ...server },
	});
	expect(body.errors).toEqual({});
};

/** Starts connecting as `user`: the authorization URL. */
const start = async (user: string, on: keyof typeof api = "https") => {
	const { status, body } = await call(user, "POST", "/connections/github", {
		on,
	});
	expect(status).toBe(200);
	return new URL(body.url);
};
const callback = (
	user: string,
	query: URLSearchParams,
	on: keyof typeof api = "https",
) => call(user, "GET", `/connections/callback?${query}`, { on });
const listed = async (user: string) =>
	(await call(user, "GET", "/connections")).body;

describe.skipIf(!url)("a User's Connections through the api", () => {
	const reset = async () => {
		await db.execute(sql`truncate mcp_server, agent cascade`);
		// the config needs a default Agent
		await config.agents.save({
			id: "general",
			create: true,
			definition: {
				name: "General",
				description: "d",
				instructions: "",
				default: true,
			},
		});
		as = fakeAuthorizationServer();
		// the names the Admin sees, from the local User records
		await db
			.insert(userRecord)
			.values(
				Object.values(users).map(({ id, name }) => ({
					id,
					name,
					lastActiveAt: new Date(),
				})),
			)
			.onConflictDoNothing();
	};
	beforeEach(reset);
	afterAll(reset);

	it("connects in the authorization server's own page, then lists the server connected", async () => {
		await save({});
		await config.agents.save({
			id: "coder",
			create: true,
			definition: {
				name: "Coder",
				description: "d",
				instructions: "",
				tools: ["mcp:github"],
			},
		});
		expect(await listed("u1")).toEqual([
			{
				id: "github",
				name: "GitHub",
				disabled: false,
				agents: ["Coder"],
				status: "none",
				connectedAt: null,
			},
		]);

		const authorization = await start("u1");
		expect(authorization.origin).toBe("https://as.example.com");
		const q = authorization.searchParams;
		expect(q.get("state")).toBeTruthy();
		expect(q.get("code_challenge_method")).toBe("S256");
		expect(q.get("resource")).toBe(github.url);
		expect(q.get("redirect_uri")).toBe(
			`${apps.https}/api/connections/callback`,
		);

		const back = await callback("u1", as.authorize(authorization.href));
		expect(back.status).toBe(302);
		expect(back.location).toBe("/connections?connected=github");
		const [row] = await listed("u1");
		expect(row.status).toBe("connected");
		expect(new Date(row.connectedAt).getTime()).toBeGreaterThan(
			Date.now() - 60_000,
		);
		expect(JSON.stringify(row)).not.toContain("access-");
	});

	it("never connects on a wrong, used, expired or another User's state, or an iss that is not the authorization server's", async () => {
		await save({});
		const failed = async (
			user: string,
			query: URLSearchParams,
			error: string,
		) => {
			const back = await callback(user, query);
			expect(back.status).toBe(302);
			expect(back.location).toBe(`/connections?error=${error}`);
		};

		const theirs = as.authorize((await start("u2")).href);
		await failed("u1", theirs, "state_invalid");
		const wrong = as.authorize((await start("u1")).href);
		wrong.set("state", "guessed");
		await failed("u1", wrong, "state_invalid");

		const forged = as.authorize((await start("u1")).href);
		forged.set("iss", "https://evil.example.com");
		forged.set("error", "access_denied");
		await failed("u1", forged, "issuer_mismatch");

		const late = as.authorize((await start("u1")).href);
		await db.execute(
			sql`update mcp_pending_authorization set created_at = now() - interval '1 hour'`,
		);
		await failed("u1", late, "state_invalid");

		const used = as.authorize((await start("u1")).href);
		expect((await callback("u1", used)).location).toBe(
			"/connections?connected=github",
		);
		await failed("u1", used, "state_invalid");
		expect((await listed("u2"))[0].status).toBe("none");
	});

	it("voids an earlier authorization when the User starts again", async () => {
		await save({});
		const first = as.authorize((await start("u1")).href);
		await start("u1");
		expect((await callback("u1", first)).location).toBe(
			"/connections?error=state_invalid",
		);
	});

	it("says when the User declined at the authorization server", async () => {
		await save({});
		const q = as.authorize((await start("u1")).href);
		q.delete("code");
		q.set("error", "access_denied");
		expect((await callback("u1", q)).location).toBe(
			"/connections?error=denied",
		);
		expect((await listed("u1"))[0].status).toBe("none");
	});

	it("uses the pre-registered Client when the Admin filled one in", async () => {
		as.cimd = true;
		await save({ oauthClientId: "orq-app", oauthClientSecret: "s3cret" });
		const authorization = await start("u1");
		expect(authorization.searchParams.get("client_id")).toBe("orq-app");
		await callback("u1", as.authorize(authorization.href));
		expect((await listed("u1"))[0].status).toBe("connected");
		expect(as.registered).toEqual([]);
	});

	it("is its Client ID Metadata Document when the authorization server supports one and Orqestra is on https", async () => {
		as.cimd = true;
		await save({});
		const authorization = await start("u1");
		const cimd = `${apps.https}/api/connections/client-metadata.json`;
		expect(authorization.searchParams.get("client_id")).toBe(cimd);
		expect(as.registered).toEqual([]);
		await callback("u1", as.authorize(authorization.href));
		expect((await listed("u1"))[0].status).toBe("connected");

		// on plain http the authorization server could not fetch it
		const plain = await start("u2", "http");
		expect(plain.searchParams.get("client_id")).toBe(as.registered[0]);
	});

	it("serves a Client ID Metadata Document naming itself and the callback, signed out", async () => {
		const { status, body } = await call(
			"",
			"GET",
			"/connections/client-metadata.json",
		);
		expect(status).toBe(200);
		expect(body).toMatchObject({
			client_id: `${apps.https}/api/connections/client-metadata.json`,
			client_name: "Orqestra",
			redirect_uris: [`${apps.https}/api/connections/callback`],
			grant_types: ["authorization_code", "refresh_token"],
			token_endpoint_auth_method: "none",
		});
	});

	it("registers once for every User, and again when the authorization server changes", async () => {
		await save({});
		const first = await start("u1");
		await callback("u1", as.authorize(first.href));
		const second = await start("u2");
		expect(as.registered).toHaveLength(1);
		expect(second.searchParams.get("client_id")).toBe(as.registered[0]);
		await callback("u2", as.authorize(second.href));
		expect((await listed("u2"))[0].status).toBe("connected");

		as.issuer = "https://as2.example.com";
		const moved = await start("u3");
		expect(moved.origin).toBe("https://as2.example.com");
		expect(as.registered).toHaveLength(2);
		expect(moved.searchParams.get("client_id")).toBe(as.registered[1]);
		await start("u3");
		expect(as.registered).toHaveLength(2);
	});

	it("asks for a pre-registered Client when the authorization server takes no other", async () => {
		as.registration = false;
		await save({});
		const { status, body } = await call("u1", "POST", "/connections/github");
		expect(status).toBe(422);
		expect(body).toMatchObject({
			errors: { serverId: { code: "oauth_client_required" } },
		});
	});

	it("connects only to an enabled per-User OAuth server, and not twice", async () => {
		await save({});
		await save({ id: "shared", auth: "shared", url: "https://s.example.com" });
		await save({ id: "off", enabled: false });
		const code = async (id: string) => {
			const { status, body } = await call("u1", "POST", `/connections/${id}`);
			return [status, body.errors?.serverId?.code];
		};
		expect(await code("nope")).toEqual([404, "not_found"]);
		expect(await code("shared")).toEqual([404, "not_found"]);
		expect(await code("off")).toEqual([409, "server_disabled"]);
		await callback("u1", as.authorize((await start("u1")).href));
		expect(await code("github")).toEqual([409, "connection_exists"]);
		expect((await listed("u1")).map((r: { id: string }) => r.id)).toEqual([
			"github",
			"off",
		]);
		expect((await listed("u1"))[1].disabled).toBe(true);
	});

	it("shows each User only their own Connections, and none signed out", async () => {
		await save({});
		await callback("u1", as.authorize((await start("u1")).href));
		expect((await listed("u1"))[0].status).toBe("connected");
		expect((await listed("u2"))[0].status).toBe("none");
		expect((await call("", "GET", "/connections")).status).toBe(401);
		expect((await call("", "POST", "/connections/github")).status).toBe(401);
	});

	const connect = async (user: string) =>
		expect(
			(await callback(user, as.authorize((await start(user)).href))).location,
		).toBe("/connections?connected=github");
	const disconnect = (user: string) =>
		call(user, "DELETE", "/connections/github");
	/** Revocations after an Admin's change run in the background. */
	const revocations = async (count: number) => {
		for (let i = 0; i < 100 && as.revoked.length < count; i++)
			await Bun.sleep(10);
		return as.revoked;
	};

	it("disconnects the User's own Connection and revokes its refresh token", async () => {
		await save({});
		await connect("u1");
		await connect("u2");
		expect((await disconnect("u1")).status).toBe(200);
		expect((await listed("u1"))[0].status).toBe("none");
		expect((await listed("u2"))[0].status).toBe("connected");
		expect(as.revoked).toEqual([
			{
				token: expect.stringMatching(/^refresh-/),
				hint: "refresh_token",
				clientId: as.registered[0],
			},
		]);
		expect((await disconnect("u1")).status).toBe(404);
		// an Admin cannot disconnect anyone else
		expect((await disconnect("a1")).status).toBe(404);
		expect((await listed("u2"))[0].status).toBe("connected");
	});

	it("disconnects all the same when revoking fails or the authorization server cannot revoke", async () => {
		await save({});
		await connect("u1");
		await connect("u2");
		as.revocation = "fails";
		expect((await disconnect("u1")).status).toBe(200);
		expect((await listed("u1"))[0].status).toBe("none");
		as.revocation = false;
		expect((await disconnect("u2")).status).toBe(200);
		expect((await listed("u2"))[0].status).toBe("none");
		expect(as.revoked).toEqual([]);
	});

	it("revokes as the pre-registered Client", async () => {
		await save({ oauthClientId: "orq-app", oauthClientSecret: "s3cret" });
		await connect("u1");
		await disconnect("u1");
		expect(as.revoked.map((r) => r.clientId)).toEqual(["orq-app"]);
	});

	it("ends every Connection and pending authorization when the Admin changes the URL, auth mode or pre-registered Client, and revokes them", async () => {
		const client = { oauthClientId: "orq-app", oauthClientSecret: "s3cret" };
		const changes = [
			{ url: "https://mcp.example.com/mcp/v2" },
			{ auth: "shared" as const },
			{ oauthClientId: "orq-app-2" },
			{ oauthClientSecret: "other" },
		];
		for (const change of changes) {
			await reset();
			await save(client);
			await connect("u1");
			await connect("u2");
			const pending = as.authorize((await start("u3")).href);
			await save({ create: false, ...client, ...change });
			if (change.auth) await save({ create: false, ...client });
			expect((await listed("u1"))[0].status).toBe("none");
			expect((await listed("u2"))[0].status).toBe("none");
			expect(await revocations(2)).toHaveLength(2);
			expect((await callback("u3", pending)).location).toBe(
				"/connections?error=state_invalid",
			);
		}
	});

	it("keeps Connections when the Admin renames, disables or saves the same Client again", async () => {
		const client = { oauthClientId: "orq-app", oauthClientSecret: "s3cret" };
		await save(client);
		await connect("u1");
		await save({ create: false, ...client, name: "GitHub!" });
		await save({ create: false, ...client, oauthClientSecret: "" });
		await call("a1", "PUT", "/mcp-servers/enabled", {
			body: { id: "github", enabled: false },
		});
		expect((await listed("u1"))[0]).toMatchObject({
			status: "connected",
			disabled: true,
		});
		expect(as.revoked).toEqual([]);
	});

	it("ends every Connection when the Admin deletes the MCP Server, and revokes them", async () => {
		await save({});
		await connect("u1");
		expect((await call("a1", "DELETE", "/mcp-servers/github")).status).toBe(
			200,
		);
		expect(await listed("u1")).toEqual([]);
		expect(await revocations(1)).toHaveLength(1);
		await save({});
		expect((await listed("u1"))[0].status).toBe("none");
	});

	it("lists a per-User OAuth server's connected Users for the Admin: name, when, status, never a token", async () => {
		await save({});
		await save({ id: "shared", auth: "shared", url: "https://s.example.com" });
		await connect("u1");
		await connect("u2");
		await db.execute(
			sql`update mcp_connection set status = 'needs_reconnect' where user_id = 'u2'`,
		);
		const { body } = await call("a1", "GET", "/mcp-servers");
		const oauth = body.find((s: { id: string }) => s.id === "github");
		expect(
			oauth.connections.map((c: { name: string; status: string }) => [
				c.name,
				c.status,
			]),
		).toEqual([
			["Uma", "connected"],
			["Ugo", "needs_reconnect"],
		]);
		expect(
			new Date(oauth.connections[0].connectedAt).getTime(),
		).toBeGreaterThan(Date.now() - 60_000);
		expect(JSON.stringify(body)).not.toMatch(/access-|refresh-/);
		expect(
			body.find((s: { id: string }) => s.id === "shared").connections,
		).toBeUndefined();
	});
});
