// Polaris' SDK is written for Node: this runs it on Bun against a fake issuer, from sign-in through a refresh.
import { afterAll, describe, expect, it } from "bun:test";
import type { Conversations } from "@orqestra/conversations";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { createApp } from "./app.ts";
import type { Capabilities } from "./capabilities.ts";
import { ADMIN_ENTITLEMENT } from "./identity.ts";
import { polaris } from "./polaris.ts";

const { publicKey, privateKey } = await generateKeyPair("RS256");
const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256" };
const sign = (claims: Record<string, unknown>, typ: string) =>
	new SignJWT(claims)
		.setProtectedHeader({ alg: "RS256", kid: "k1", typ })
		.setIssuer(issuer)
		.setIssuedAt()
		.setExpirationTime("10m")
		.sign(privateKey);

const refreshTokens: string[] = [];
let nonce = "";
// the access token's lifetime; under the SDK's 60s margin, every read refreshes
let expiresIn = 30;
const server = Bun.serve({
	port: 0,
	async fetch(request): Promise<Response> {
		const path = new URL(request.url).pathname;
		if (path === "/.well-known/openid-configuration")
			return Response.json({
				issuer,
				authorization_endpoint: `${issuer}/authorize`,
				token_endpoint: `${issuer}/token`,
				end_session_endpoint: `${issuer}/logout`,
				jwks_uri: `${issuer}/jwks`,
			});
		if (path === "/jwks") return Response.json({ keys: [jwk] });
		if (path === "/token") {
			const form = new URLSearchParams(await request.text());
			const rt = form.get("refresh_token");
			if (rt) refreshTokens.push(rt);
			return Response.json({
				token_type: "Bearer",
				expires_in: expiresIn,
				refresh_token: `rt${refreshTokens.length + 1}`,
				access_token: await sign(
					{
						sub: "s1",
						aud: "orqestra",
						client_id: "orq",
						entitlements: [ADMIN_ENTITLEMENT],
					},
					"at+jwt",
				),
				...(rt
					? {}
					: {
							id_token: await sign(
								{ sub: "s1", aud: "orq", nonce, name: "Ada" },
								"JWT",
							),
						}),
			});
		}
		return new Response("not found", { status: 404 });
	},
});
const issuer = `http://localhost:${server.port}`;
afterAll(() => server.stop(true));

const app = createApp({
	config: {} as Capabilities,
	...polaris({
		ORQESTRA_URL: "http://orqestra.test",
		POLARIS_ISSUER: issuer,
		POLARIS_CLIENT_ID: "orq",
		POLARIS_CLIENT_SECRET: "secret",
		POLARIS_AUDIENCE: "orqestra",
		POLARIS_SECRET: "a".repeat(32),
	}),
	// only /api/session and /auth/* are reached here
	conversations: {} as Conversations,
});
const handle = (request: Request) => app.handle(request);
const cookieOf = (response: Response) =>
	response.headers
		.getSetCookie()
		.map((c) => c.split(";")[0])
		.join("; ");
const session = (cookie: string) =>
	handle(
		new Request("http://orqestra.test/api/session", { headers: { cookie } }),
	);

describe("Polaris on Bun", () => {
	it("signs in, then refreshes the expiring session once and writes back its cookie", async () => {
		const login = await handle(
			new Request("http://orqestra.test/auth/login?returnTo=/c/1"),
		);
		const authorize = new URL(login.headers.get("location") ?? "");
		expect(authorize.origin).toBe(issuer);
		expect(authorize.searchParams.get("redirect_uri")).toBe(
			"http://orqestra.test/auth/callback",
		);
		nonce = authorize.searchParams.get("nonce") ?? "";

		const callback = await handle(
			new Request(
				`http://orqestra.test/auth/callback?code=c&state=${authorize.searchParams.get("state")}`,
				{ headers: { cookie: cookieOf(login) } },
			),
		);
		expect(callback.status).toBe(302);
		expect(callback.headers.get("location")).toBe("/c/1");
		const signedIn = cookieOf(callback);
		expect(signedIn).toContain("polaris.session=");

		expiresIn = 600;
		const refreshed = await session(signedIn);
		expect(await refreshed.json()).toEqual({
			id: "s1",
			name: "Ada",
			admin: true,
		});
		expect(refreshTokens).toEqual(["rt1"]);
		const cookie = cookieOf(refreshed);
		expect(cookie).toContain("polaris.session=");
		expect(cookie).not.toBe(signedIn);

		// the refreshed cookie holds the new tokens: read again, nothing to refresh
		const again = await session(cookie);
		expect(await again.json()).toEqual({ id: "s1", name: "Ada", admin: true });
		expect(again.headers.getSetCookie()).toEqual([]);
		expect(refreshTokens).toEqual(["rt1"]);
	});

	it("is 401 without a session cookie, or with one from another secret", async () => {
		expect((await session("")).status).toBe(401);
		const forged = await session("polaris.session=not-sealed");
		expect(forged.status).toBe(401);
		// the unreadable cookie is cleared
		expect(forged.headers.getSetCookie()[0]).toContain("Max-Age=0");
	});
});
