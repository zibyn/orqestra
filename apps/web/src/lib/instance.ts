import { redirect } from "@tanstack/react-router";
import { api, sessionUser } from "#/lib/api";

// The signed-in User or null; checked on every navigation by the root route. During SSR it is the
// page's first call to the api, so that any refresh happens before the others.
export const getUser = () => sessionUser(api());

/** Sends a signed-out visitor to Polaris, which brings them back to returnTo (a path on this site). */
export const signIn = (returnTo: string) =>
	redirect({
		href: `/auth/login?returnTo=${encodeURIComponent(returnTo)}`,
		reloadDocument: true,
	});
