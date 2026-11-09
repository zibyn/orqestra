import { describe, expect, it } from "bun:test";
import { createApp, type Session } from "./app.ts";

const ada = { id: "s1", name: "Ada", admin: true };

/** The app with a fake session reader: every request reads as signed in as user, with cookies to set. */
function app(user: typeof ada | null, cookies: string[] = []) {
	const reads: Request[] = [];
	const session: Session = async (request) => {
		reads.push(request);
		return { user, cookies };
	};
	const auth = async (request: Request) =>
		new Response(`auth ${new URL(request.url).pathname}`, {
			headers: { "set-cookie": "polaris.tx=t; Path=/" },
		});
	const api = createApp({ session, auth });
	// handle needs its app as this
	return { handle: (request: Request) => api.handle(request), reads };
}

// Elysia finds the path after the 11th character: a host as short as http://api/ reads as 404
const get = (path: string) => new Request(`http://localhost${path}`);

describe("/api/session", () => {
	it("returns the signed-in User", async () => {
		const response = await app(ada).handle(get("/api/session"));
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual(ada);
	});

	it("is 401 without a session", async () => {
		const response = await app(null).handle(get("/api/session"));
		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({
			errors: { session: { code: "unauthorized" } },
		});
	});

	it("writes back every Set-Cookie a refresh produced, signed in or out", async () => {
		const cookies = [
			"polaris.session.0=a; Path=/",
			"polaris.session.1=b; Path=/",
		];
		for (const user of [ada, null]) {
			const response = await app(user, cookies).handle(get("/api/session"));
			expect(response.headers.getSetCookie()).toEqual(cookies);
		}
	});

	it("reads the session once per request", async () => {
		const { handle, reads } = app(ada);
		await handle(get("/api/session"));
		expect(reads).toHaveLength(1);
	});
});

describe("/auth/*", () => {
	it("is Polaris' handler, its response passed through", async () => {
		const { handle, reads } = app(null);
		for (const [method, path] of [
			["GET", "/auth/login"],
			["GET", "/auth/callback"],
			["POST", "/auth/logout"],
		]) {
			const response = await handle(
				new Request(`http://localhost${path}`, { method }),
			);
			expect(await response.text()).toBe(`auth ${path}`);
			expect(response.headers.getSetCookie()).toEqual(["polaris.tx=t; Path=/"]);
		}
		// signing in or out does not read the session first
		expect(reads).toHaveLength(0);
	});
});
