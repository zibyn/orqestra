import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import type { Conversations } from "@orqestra/conversations";
import { db } from "@orqestra/db";
import { fakeLinear } from "@orqestra/linear/testing";
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
	config: createCapabilities(db),
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
		await db.execute(sql`truncate linear_installation`);
		linear = fakeLinear();
	};
	beforeEach(reset);
	afterAll(reset);

	it("installs the app as itself from Linear's authorization page, then names the workspace, never sending a secret back", async () => {
		const before = await call("GET", "/linear");
		expect(before.body).toEqual({
			installation: null,
			callbackUrl: `${orqestraUrl}/api/linear/callback`,
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
			clientSecretReadable: true,
			webhookSecretReadable: true,
			workspace: "Acme",
		});
		const [row] = (
			await db.execute<{
				client_secret: string;
				webhook_secret: string;
				tokens: string;
			}>(
				sql`select client_secret, webhook_secret, tokens from linear_installation`,
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
			sql`update linear_installation set pending_at = now() - interval '1 hour'`,
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

	it("is for Admins only, the callback too", async () => {
		await start();
		for (const [method, path] of [
			["GET", "/linear"],
			["POST", "/linear"],
			["GET", "/linear/callback?code=c&state=s"],
		] as const) {
			const { status } = await call(method, path, {
				user: "u1",
				body: method === "POST" ? credentials : undefined,
			});
			expect(status).toBe(403);
		}
		expect((await call("GET", "/linear", { user: "nobody" })).status).toBe(401);
	});
});
