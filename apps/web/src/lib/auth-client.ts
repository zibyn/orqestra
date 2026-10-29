import { adminClient, inferAdditionalFields } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";
import type { auth } from "#/lib/auth";

export const authClient = createAuthClient({
	plugins: [adminClient(), inferAdditionalFields<typeof auth>()],
});

// Polaris accounts get sent to its end_session_endpoint; password sessions just land on /login
export async function signOut() {
	const { data } = await authClient.signOut({
		callbackURL: "/login",
		disableRedirect: true,
	});
	window.location.href = data?.url ?? "/login";
}
