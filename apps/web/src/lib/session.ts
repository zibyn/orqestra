import { getRequestHeaders } from "@tanstack/react-start/server";
import { auth } from "#/lib/auth";
import { isAdmin } from "#/lib/identity";

// Server-only guards for server function handlers. They live apart from the createServerFn files:
// an exported plain function there keeps `auth` (and pg) in the client bundle.

export async function requireUserId() {
	const session = await auth.api.getSession({ headers: getRequestHeaders() });
	if (!session) throw new Error("Unauthorized");
	return session.user.id;
}

export async function requireAdmin() {
	const session = await auth.api.getSession({ headers: getRequestHeaders() });
	if (!isAdmin(session?.user)) throw new Error("Forbidden");
}
