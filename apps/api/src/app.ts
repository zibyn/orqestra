import { Elysia } from "elysia";
import type { User } from "./identity.ts";
import { memoryRoutes } from "./memories.ts";

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

/** The /api group as a domain's routes see it: the signed-in User, or null, resolved. */
export type SignedIn = Elysia<
	"",
	{
		decorator: Record<string, never>;
		store: Record<string, never>;
		derive: Record<string, never>;
		resolve: { user: User | null };
	}
>;

/** The api; production passes Polaris (see polaris.ts), tests a fake. */
export function createApp({ session, auth }: { session: Session; auth: Auth }) {
	return new Elysia()
		.all("/auth/*", ({ request }) => auth(request))
		.group("/api", (api) =>
			api
				// once per request, so that only one read may refresh
				.resolve(async ({ request, set }) => {
					const { user, cookies } = await session(request);
					if (cookies.length) set.headers["set-cookie"] = cookies;
					return { user };
				})
				.get(
					"/session",
					({ user, status }) =>
						user ??
						status(401, { errors: { session: { code: "unauthorized" } } }),
				)
				.use(memoryRoutes),
		);
}

export type App = ReturnType<typeof createApp>;
