import { Elysia } from "elysia";
import type { User } from "./identity.ts";

/**
 * Reads the signed-in User from a request, refreshing the session when due. Every cookie in
 * cookies must reach the browser: a refresh rotates the refresh token, and the stale one reused
 * later ends the whole Polaris Session.
 */
export type Session = (
	request: Request,
) => Promise<{ user: User | null; cookies: string[] }>;

export const unauthorized = { errors: { session: { code: "unauthorized" } } };

/**
 * `user` for every route of the app and of the plugins that use it. Named, so Elysia applies it
 * once however many plugins use it: only one read per request may refresh.
 */
export const sessionPlugin = (session: Session) =>
	new Elysia({ name: "session" }).resolve(
		{ as: "scoped" },
		async ({ request, set }) => {
			const { user, cookies } = await session(request);
			if (cookies.length) set.headers["set-cookie"] = cookies;
			return { user };
		},
	);

export type SessionPlugin = ReturnType<typeof sessionPlugin>;

/** sessionPlugin for routes only a User may call: 401 without one. */
export const signedIn = (session: SessionPlugin) =>
	new Elysia()
		.use(session)
		.resolve({ as: "scoped" }, ({ user, status }) =>
			user ? { user } : status(401, unauthorized),
		);
