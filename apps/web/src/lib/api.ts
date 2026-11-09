import { treaty } from "@elysiajs/eden";
import type { App } from "@orqestra/api";
import { createIsomorphicFn } from "@tanstack/react-start";
import { requestApi } from "#/lib/session";

export type Api = ReturnType<typeof treaty<App>>;

let browser: Api | undefined;

/** The api: at API_URL during SSR, with the page's cookie; at this origin in the browser. */
export const api = createIsomorphicFn()
	.server(() => requestApi())
	.client(() => {
		browser ??= treaty<App>(location.origin);
		return browser;
	});

/** The signed-in User, or null. */
export async function sessionUser(client: Api) {
	const { data, error } = await client.api.session.get();
	if (error?.status === 401) return null;
	if (error) throw error;
	return data;
}
