import { status } from "elysia";
import type { User } from "./identity.ts";

/** A beforeHandle refusing anyone but an Admin: 401 when signed out, 403 for a Member. */
export function adminOnly({ user }: { user: User | null }) {
	if (!user)
		return status(401, { errors: { session: { code: "unauthorized" } } });
	if (!user.admin)
		return status(403, { errors: { session: { code: "forbidden" } } });
}
