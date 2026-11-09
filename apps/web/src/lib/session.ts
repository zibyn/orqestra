import { treaty } from "@elysiajs/eden";
import type { App } from "@orqestra/api";
import { appendResponseHeader, getRequest } from "@tanstack/react-start/server";
import { env } from "#/env";
import type { Api } from "#/lib/api";
import { sessionFirst } from "#/lib/session-first";

// Server only: api()'s server side, for SSR.

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
