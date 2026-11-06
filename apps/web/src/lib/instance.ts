import { redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { currentUser } from "#/lib/session";

// The signed-in User or null; checked on every navigation by the root route.
export const getUser = createServerFn().handler(() => currentUser());

/** Sends a signed-out visitor to Polaris, which brings them back to returnTo (a path on this site). */
export const signIn = (returnTo: string) =>
	redirect({
		href: `/auth/login?returnTo=${encodeURIComponent(returnTo)}`,
		reloadDocument: true,
	});
