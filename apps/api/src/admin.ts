import { status } from "elysia";
import type { User } from "./identity.ts";

export const unauthorized = { errors: { session: { code: "unauthorized" } } };

// Both are derives, so they run before the body is validated: a refused request learns nothing of its fields

/** A derive refusing anyone signed out with 401; `user` is then the User. */
export const signedInOnly = ({ user }: { user: User | null }) =>
	user ? { user } : status(401, unauthorized);

/** A derive refusing anyone but an Admin: 401 when signed out, 403 for a Member. */
export function adminOnly({ user }: { user: User | null }) {
	if (!user) return status(401, unauthorized);
	if (!user.admin)
		return status(403, { errors: { session: { code: "forbidden" } } });
	return {};
}
