import { treaty } from "@elysiajs/eden";
import type { App } from "@orqestra/api";
import { appendResponseHeader, getRequest } from "@tanstack/react-start/server";
import { env } from "#/env";
import { type Api, sessionUser } from "#/lib/api";
import { sessionFirst } from "#/lib/session-first";

// Server only: server function handlers, server routes and api()'s server side use it. It lives
// apart from the createServerFn files, as an exported plain function there stays in the client bundle.

const clients = new WeakMap<Request, Api>();

/**
 * The api for one request web is serving, carrying its cookie. Every cookie handed to setCookie
 * must reach the browser: it may come from a refresh (see sessionFirst).
 */
export function serverApi(
	request: Request,
	setCookie: (cookie: string) => void,
) {
	let client = clients.get(request);
	if (!client) {
		client = treaty<App>(env.API_URL, {
			fetcher: sessionFirst(
				fetch,
				request.headers.get("cookie") ?? "",
				setCookie,
			),
		});
		clients.set(request, client);
	}
	return client;
}

/** serverApi for the request being served, its cookies set on its response. */
export function requestApi() {
	return serverApi(getRequest(), (cookie) =>
		appendResponseHeader("set-cookie", cookie),
	);
}

/** The signed-in User, or null. */
export function readUser(
	request: Request,
	setCookie: (cookie: string) => void,
) {
	return sessionUser(serverApi(request, setCookie));
}

/** readUser for a server function's own request and response. */
export function currentUser() {
	return sessionUser(requestApi());
}

export async function requireUserId() {
	const user = await currentUser();
	if (!user) throw new Error("Unauthorized");
	return user.id;
}

export async function requireAdmin() {
	if (!(await currentUser())?.admin) throw new Error("Forbidden");
}
