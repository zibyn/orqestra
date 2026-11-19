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
import { memoryStore } from "@orqestra/db/store";
import { accessToken, GrantRefused } from "@orqestra/integrations";
import { linear as source } from "@orqestra/integrations/linear";
import { fakeLinear } from "@orqestra/integrations/testing";
import { sql } from "drizzle-orm";
import { createApp } from "./app.ts";
import { createCapabilities } from "./capabilities.ts";

// Installing the Linear app through the api, against a migrated, throwaway Postgres: TEST_DATABASE_URL is wiped before every test.
// Linear is a fake behind the injected fetch.
const url = process.env.TEST_DATABASE_URL;

const users: Record<string, { id: string; name: string; admin: boolean }> = {
	a1: { id: "a1", name: "Ada", admin: true },
	u1: { id: "u1", name: "Uma", admin: false },
};

let linear = fakeLinear();
const orqestraUrl = "https://orqestra.example.com";
const api = createApp({
	config: createCapabilities(db, memoryStore().store),
	session: async (request) => ({
		user: users[request.headers.get("x-user") ?? ""] ?? null,
		cookies: [],
	}),
	auth: () => new Response(null, { status: 404 }),
	conversations: {} as Conversations,
	orqestraUrl,
	// looked up per request, so each test's fake is used
	fetch: (input, init) => linear.fetch(input, init),
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
		location: response.headers.get("location"),
		text,
		body: text ? JSON.parse(text) : null,
	};
}

const credentials = {
	clientId: "lin-client",
	clientSecret: "client-s3cret",
	webhookSecret: "hook-s3cret",
};

/** Saves the credentials and starts installing: the Linear authorization URL. */
const start = async (body: Record<string, string> = credentials) => {
	const { status, body: started } = await call("POST", "/linear", { body });
	expect(status).toBe(200);
	return started.url as string;
};
const callback = (query: URLSearchParams) =>
	call("GET", `/linear/callback?${query}`);
const workspace = async () =>
	(await call("GET", "/linear")).body.installation?.workspace;

describe.skipIf(!url)("installing the Linear app through the api", () => {
	const reset = async () => {
		await db.execute(sql`truncate integration_installation`);
		linear = fakeLinear();
	};
	beforeEach(reset);
	afterAll(reset);

	it("installs the app as itself from Linear's authorization page, then names the workspace, never sending a secret back", async () => {
		const before = await call("GET", "/linear");
		expect(before.body).toEqual({
			installation: null,
			callbackUrl: `${orqestraUrl}/api/linear/callback`,
			webhookUrl: `${orqestraUrl}/api/linear/webhook`,
		});

		const {
			status,
			text: startText,
			body,
		} = await call("POST", "/linear", {
			body: credentials,
		});
		expect(status).toBe(200);
		const authorization = new URL(body.url);
		expect(authorization.origin + authorization.pathname).toBe(
			"https://linear.app/oauth/authorize",
		);
		const q = authorization.searchParams;
		expect(q.get("actor")).toBe("app");
		expect(q.get("client_id")).toBe("lin-client");
		expect(q.get("response_type")).toBe("code");
		expect(q.get("scope")).toBe("read,write,app:assignable,app:mentionable");
		expect(q.get("redirect_uri")).toBe(`${orqestraUrl}/api/linear/callback`);
		expect(q.get("state")?.length).toBeGreaterThanOrEqual(32);

		const back = await callback(linear.authorize(body.url));
		expect(back.status).toBe(302);
		expect(back.location).toBe("/console/linear");

		const after = await call("GET", "/linear");
		expect(after.body.installation).toEqual({
			clientId: "lin-client",
			defaultAgentId: null,
			teamRepos: {},
			clientSecretReadable: true,
			webhookSecretReadable: true,
			workspace: "Acme",
			needsReinstall: false,
		});
		const [row] = (
			await db.execute<{
				client_secret: string;
				webhook_secret: string;
				tokens: string;
			}>(
				sql`select client_secret, webhook_secret, tokens from integration_installation`,
			)
		).rows;
		const sent = [before.text, startText, after.text].join();
		for (const secret of [
			...Object.values(row),
			"client-s3cret",
			"hook-s3cret",
			"access-1",
			"refresh-1",
		])
			expect(sent).not.toContain(secret);
		expect(Object.values(row).join()).not.toMatch(/s3cret|access-1|refresh-1/);
	});

	it("says the installation needs installing again once Linear refuses to refresh its tokens, never sending a secret back, until it is", async () => {
		await callback(linear.authorize(await start()));
		// a day on, access-1 has expired, and the app's refresh-1 is one Linear revoked
		linear.refreshTokens.clear();
		setSystemTime(new Date(Date.now() + 25 * 3_600_000));
		try {
			await expect(
				accessToken(source, { fetch: linear.fetch }),
			).rejects.toBeInstanceOf(GrantRefused);
		} finally {
			setSystemTime();
		}
		const refused = await call("GET", "/linear");
		expect(refused.body.installation).toMatchObject({
			workspace: "Acme",
			needsReinstall: true,
		});
		const [row] = (
			await db.execute<{
				client_secret: string;
				webhook_secret: string;
				tokens: string;
			}>(
				sql`select client_secret, webhook_secret, tokens from integration_installation`,
			)
		).rows;
		for (const secret of [
			...Object.values(row),
			"client-s3cret",
			"hook-s3cret",
			"access-1",
			"refresh-1",
		])
			expect(refused.text).not.toContain(secret);

		expect(
			(
				await callback(
					linear.authorize(await start({ clientId: "lin-client" })),
				)
			).location,
		).toBe("/console/linear");
		expect((await call("GET", "/linear")).body.installation).toMatchObject({
			workspace: "Acme",
			needsReinstall: false,
		});
	});

	it("never installs on a wrong, used, expired or voided state", async () => {
		const failed = async (query: URLSearchParams) => {
			const back = await callback(query);
			expect(back.status).toBe(302);
			expect(back.location).toBe("/console/linear?error=state_invalid");
		};

		const wrong = linear.authorize(await start());
		wrong.set("state", "guessed");
		await failed(wrong);
		wrong.delete("state");
		await failed(wrong);

		const late = linear.authorize(await start());
		await db.execute(
			sql`update integration_installation set pending_at = now() - interval '1 hour'`,
		);
		await failed(late);

		const voided = linear.authorize(await start());
		await start();
		await failed(voided);
		expect(linear.tokenRequests).toEqual([]);
		expect(await workspace()).toBeNull();

		const used = linear.authorize(await start());
		expect((await callback(used)).location).toBe("/console/linear");
		await failed(used);
		expect(linear.tokenRequests).toHaveLength(1);
	});

	it("says when the Admin declined at Linear, or Linear refused the code", async () => {
		const declined = linear.authorize(await start());
		declined.delete("code");
		declined.set("error", "access_denied");
		expect((await callback(declined)).location).toBe(
			"/console/linear?error=denied",
		);

		linear.clientSecret = "rotated";
		expect((await callback(linear.authorize(await start()))).location).toBe(
			"/console/linear?error=failed",
		);
		expect(await workspace()).toBeNull();
	});

	it("asks for both secrets the first time, keeps them when left blank, and forgets the installation for another app", async () => {
		const missing = await call("POST", "/linear", {
			body: { clientId: "lin-client" },
		});
		expect(missing.status).toBe(422);
		expect(missing.body.errors).toEqual({
			clientSecret: { code: "secret_required" },
			webhookSecret: { code: "secret_required" },
		});
		expect((await call("GET", "/linear")).body.installation).toBeNull();

		await callback(linear.authorize(await start()));
		// installing again, the secrets left blank: the stored ones redeem the code
		const again = linear.authorize(await start({ clientId: "lin-client" }));
		expect(await workspace()).toBe("Acme");
		expect((await callback(again)).location).toBe("/console/linear");
		expect(linear.tokenRequests.at(-1)?.client_secret).toBe("client-s3cret");

		await start({ ...credentials, clientId: "another-app" });
		expect(await workspace()).toBeNull();
	});

	it("saves the Agent of the Conversations Linear opens and each team's repository, once the app's credentials are", async () => {
		const settings = {
			defaultAgentId: "general",
			teamRepos: { ENG: "acme/web" },
		};
		const put = (body: unknown) =>
			call("PUT", "/linear/conversations", { body });
		expect((await put(settings)).body.errors).toEqual({
			"": { code: "not_found" },
		});

		await start();
		expect((await put(settings)).status).toBe(200);
		expect((await call("GET", "/linear")).body.installation).toMatchObject(
			settings,
		);
		expect(
			(await put({ ...settings, defaultAgentId: "gone" })).body.errors,
		).toEqual({ defaultAgentId: { code: "not_found" } });
		const bad = await put({ ...settings, teamRepos: { ENG: "not a repo" } });
		expect(bad.status).toBe(422);
		expect(Object.keys(bad.body.errors)).toEqual(["teamRepos.ENG"]);
	});

	it("is for Admins only, the callback too", async () => {
		await start();
		for (const [method, path] of [
			["GET", "/linear"],
			["POST", "/linear"],
			["PUT", "/linear/conversations"],
			["GET", "/linear/callback?code=c&state=s"],
		] as const) {
			const { status } = await call(method, path, {
				user: "u1",
				body:
					method === "POST"
						? credentials
						: method === "PUT"
							? { defaultAgentId: "general", teamRepos: {} }
							: undefined,
			});
			expect(status).toBe(403);
		}
		expect((await call("GET", "/linear", { user: "nobody" })).status).toBe(401);
	});
});

describe.skipIf(!url)("linking a User's Linear account through the api", () => {
	const reset = async () => {
		await db.execute(sql`truncate integration_installation, "user" cascade`);
		linear = fakeLinear();
	};
	beforeEach(async () => {
		await reset();
		for (const { id, name } of Object.values(users))
			await db.execute(
				sql`insert into "user" (id, name, email, last_active_at) values (${id}, ${name}, ${`${id}@example.com`}, now())`,
			);
	});
	afterAll(reset);

	const install = async () => {
		await callback(linear.authorize(await start()));
	};
	/** Starts linking as `user`: the Linear authorization URL. */
	const startLink = async (user = "u1") => {
		const { status, body } = await call("POST", "/linear/account", { user });
		expect(status).toBe(200);
		return body.url as string;
	};
	const linkBack = (query: URLSearchParams, user = "u1") =>
		call("GET", `/linear/callback?${query}`, { user });
	const accounts = async () =>
		(
			await db.execute<{ external_id: string; user_id: string }>(
				sql`select external_id, user_id from integration_account order by user_id`,
			)
		).rows;

	it("links the Linear user who authorized as themselves to the signed-in User, keeping none of their tokens", async () => {
		expect((await call("GET", "/linear/account", { user: "u1" })).body).toEqual(
			{ installed: false, account: null },
		);
		await install();
		const url = new URL(await startLink());
		expect(url.searchParams.get("actor")).toBeNull();
		expect(url.searchParams.get("scope")).toBe("read");
		expect(url.searchParams.get("redirect_uri")).toBe(
			`${orqestraUrl}/api/linear/callback`,
		);

		const back = await linkBack(linear.authorize(url.href));
		expect(back.status).toBe(302);
		expect(back.location).toBe("/connections?linked=linear");
		expect(await accounts()).toEqual([
			{ external_id: "lin-user-1", user_id: "u1" },
		]);
		// the app's token from the install, and the person's, revoked once read
		expect(linear.revoked).toEqual(["access-2"]);
		const status = await call("GET", "/linear/account", { user: "u1" });
		expect(status.body).toMatchObject({
			installed: true,
			account: { name: "Uma" },
		});
		expect(status.text).not.toContain("access-");

		expect(
			(await call("DELETE", "/linear/account", { user: "u1" })).status,
		).toBe(200);
		expect(await accounts()).toEqual([]);
	});

	it("never links on a state started by another User, or with none signed in, and tells the console's callback apart", async () => {
		await install();
		const query = linear.authorize(await startLink("u1"));
		expect((await linkBack(query, "a1")).location).toBe(
			"/connections?error=state_invalid",
		);
		expect((await linkBack(query, "nobody")).location).toBe(
			"/connections?error=state_invalid",
		);
		expect(await accounts()).toEqual([]);
		// an installation's state is still the Admin's
		expect(
			(await linkBack(new URLSearchParams({ code: "c", state: "s" }))).status,
		).toBe(403);
	});

	it("gives the Linear user to whoever last authorized as them, one account per User", async () => {
		await install();
		await linkBack(linear.authorize(await startLink("u1")), "u1");
		await linkBack(linear.authorize(await startLink("a1")), "a1");
		expect(await accounts()).toEqual([
			{ external_id: "lin-user-1", user_id: "a1" },
		]);
	});

	it("starts no link before the app's credentials are saved", async () => {
		const { status } = await call("POST", "/linear/account", { user: "u1" });
		expect(status).toBe(404);
	});
});
