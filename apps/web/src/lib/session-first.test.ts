import { describe, expect, it } from "vitest";
import { sessionFirst } from "#/lib/session-first";

/** A fetch that records each call and answers /api/session only once released. */
function recordingFetch() {
	const calls: { path: string; cookie: string | null }[] = [];
	let release = (_: Response) => {};
	const session = new Promise<Response>((resolve) => {
		release = resolve;
	});
	const fetch = (async (input: string | URL, init?: RequestInit) => {
		const path = new URL(input).pathname;
		calls.push({ path, cookie: new Headers(init?.headers).get("cookie") });
		return path === "/api/session" ? session : Response.json({ path });
	}) as typeof globalThis.fetch;
	return { fetch, calls, release };
}

describe("an SSR request's calls to the api", () => {
	it("read the session first and alone, forward its Set-Cookie, then carry the refreshed cookie", async () => {
		const { fetch, calls, release } = recordingFetch();
		const forwarded: string[] = [];
		const api = sessionFirst(
			fetch,
			"polaris.session.0=old0; polaris.session.1=old1; theme=dark",
			(cookie) => forwarded.push(cookie),
		);

		const later = [
			api("http://api:3001/api/conversations"),
			api("http://api:3001/api/memories", { headers: { accept: "x" } }),
		];
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(calls).toEqual([
			{
				path: "/api/session",
				cookie: "polaris.session.0=old0; polaris.session.1=old1; theme=dark",
			},
		]);

		const refresh = [
			"polaris.session.0=; Path=/; Max-Age=0; HttpOnly",
			"polaris.session.1=; Path=/; Max-Age=0; HttpOnly",
			"polaris.session=new; Path=/; Max-Age=2592000; HttpOnly",
		];
		const headers = new Headers();
		for (const cookie of refresh) headers.append("set-cookie", cookie);
		release(Response.json({ id: "s1" }, { headers }));

		await Promise.all(later);
		expect(forwarded).toEqual(refresh);
		expect(calls.slice(1)).toEqual([
			{ path: "/api/conversations", cookie: "theme=dark; polaris.session=new" },
			{ path: "/api/memories", cookie: "theme=dark; polaris.session=new" },
		]);
	});

	it("read the session once, however often it is asked for", async () => {
		const { fetch, calls, release } = recordingFetch();
		release(Response.json({ id: "s1" }));
		const api = sessionFirst(fetch, "", () => {});
		const answers = await Promise.all([
			api("http://api:3001/api/session"),
			api("http://api:3001/api/session"),
		]);
		for (const answer of answers)
			expect(await answer.json()).toEqual({ id: "s1" });
		expect(calls).toHaveLength(1);
	});
});
