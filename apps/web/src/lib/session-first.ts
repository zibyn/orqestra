/**
 * A fetch for one SSR request's calls to the api. A refresh rotates Polaris' refresh token, and two
 * calls presenting the same one end the Polaris Session: so /api/session goes first and alone, its
 * Set-Cookie goes to setCookie (the browser), and every other call waits for it and carries the
 * refreshed cookie. /api/session itself is read once; asking again answers from that read.
 */
export function sessionFirst(
	fetch: typeof globalThis.fetch,
	cookie: string,
	setCookie: (cookie: string) => void,
) {
	let session: Promise<{ response: Response; cookie: string }> | undefined;
	return (async (input: string | URL, init?: RequestInit) => {
		const url = new URL(input);
		session ??= fetch(new URL("/api/session", url), {
			headers: { cookie },
		}).then((response) => {
			const cookies = response.headers.getSetCookie();
			for (const c of cookies) setCookie(c);
			return { response, cookie: applySetCookies(cookie, cookies) };
		});
		const read = await session;
		if (url.pathname === "/api/session") return read.response.clone();
		const headers = new Headers(init?.headers);
		headers.set("cookie", read.cookie);
		return fetch(input, { ...init, headers });
	}) as typeof globalThis.fetch;
}

/** The Cookie header after the browser applies setCookies to it. */
function applySetCookies(cookie: string, setCookies: string[]) {
	const jar = new Map<string, string>();
	for (const part of cookie.split(";")) {
		const i = part.indexOf("=");
		if (i > 0) jar.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
	}
	for (const c of setCookies) {
		const [pair] = c.split(";");
		const i = pair.indexOf("=");
		if (/;\s*Max-Age=0(;|$)/i.test(c)) jar.delete(pair.slice(0, i));
		else jar.set(pair.slice(0, i), pair.slice(i + 1));
	}
	return [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
}
