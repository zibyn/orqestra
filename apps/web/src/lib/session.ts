import { appendResponseHeader, getRequest } from "@tanstack/react-start/server";
import { toUser } from "#/lib/identity";
import { polaris, verifyAccessToken } from "#/lib/polaris";

// Server-only guards for server function handlers. They live apart from the createServerFn files:
// an exported plain function there keeps the Polaris SDK in the client bundle.

/**
 * The signed-in User, or null. A refresh rotates the refresh token, so every cookie handed to
 * setCookie must reach the browser: a stale one reused later ends the whole Polaris Session.
 */
export function readUser(
	request: Request,
	setCookie: (cookie: string) => void,
) {
	// An SSR render runs several server functions on one request, all carrying the cookie as it came in:
	// only the first may refresh, or the others would present the refresh token it just used up
	let user = readByRequest.get(request);
	if (!user) {
		user = read(request, setCookie);
		readByRequest.set(request, user);
	}
	return user;
}

const readByRequest = new WeakMap<Request, ReturnType<typeof read>>();

async function read(request: Request, setCookie: (cookie: string) => void) {
	const { session, headers } = await polaris.getSession(request);
	for (const cookie of headers.getSetCookie()) setCookie(cookie);
	if (!session) return null;
	const { entitlements } = await verifyAccessToken(session.accessToken).catch(
		(err) => {
			// The SDK's message hides which check failed (aud, iss, typ…); a misconfigured Application shows here
			console.error("Polaris access token refused:", err.cause ?? err);
			throw err;
		},
	);
	return toUser(session.user, entitlements);
}

/** readUser for a server function's own request and response. */
export function currentUser() {
	return readUser(getRequest(), (cookie) =>
		appendResponseHeader("set-cookie", cookie),
	);
}

export async function requireUserId() {
	const user = await currentUser();
	if (!user) throw new Error("Unauthorized");
	return user.id;
}

export async function requireAdmin() {
	if (!(await currentUser())?.admin) throw new Error("Forbidden");
}
