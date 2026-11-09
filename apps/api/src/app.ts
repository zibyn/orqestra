import { Elysia } from "elysia";
import type { User } from "./identity.ts";
import { skills } from "./skills.ts";

export type { User };

/**
 * Reads the signed-in User from a request, refreshing the session when due. Every cookie in
 * cookies must reach the browser: a refresh rotates the refresh token, and the stale one reused
 * later ends the whole Polaris Session.
 */
export type Session = (
	request: Request,
) => Promise<{ user: User | null; cookies: string[] }>;

/** Polaris' /auth/login, /auth/callback and /auth/logout. */
export type Auth = (request: Request) => Response | Promise<Response>;

/** `user` for the routes of whoever uses it; by its name, the session is read once per request however many do. */
const signedIn = (session: Session) =>
	new Elysia({ name: "signed-in" }).resolve(
		{ as: "scoped" },
		async ({ request, set }) => {
			const { user, cookies } = await session(request);
			if (cookies.length) set.headers["set-cookie"] = cookies;
			return { user };
		},
	);
export type SignedIn = ReturnType<typeof signedIn>;

/** The api; production passes Polaris (see polaris.ts), tests a fake. */
export function createApp({ session, auth }: { session: Session; auth: Auth }) {
	const user = signedIn(session);
	return new Elysia()
		.all("/auth/*", ({ request }) => auth(request))
		.group("/api", (api) =>
			api
				.use(user)
				.use(skills(user))
				.get(
					"/session",
					({ user, status }) =>
						user ??
						status(401, { errors: { session: { code: "unauthorized" } } }),
				),
		);
}

export type App = ReturnType<typeof createApp>;
