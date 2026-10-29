// Pure identity rules, kept free of DB/auth imports so they unit-test without a database.

/** Admins have the `admin` role; everyone else is a Member. */
export function isAdmin(user: { role?: string | null } | null | undefined) {
	return user?.role === "admin";
}

const PLACEHOLDER_DOMAIN = "@polaris.invalid";

/** Shown name: email, else phone. The placeholder email is never shown. */
export function displayName(user: {
	email: string;
	phoneNumber?: string | null;
}) {
	if (!user.email.endsWith(PLACEHOLDER_DOMAIN)) return user.email;
	return user.phoneNumber ?? "";
}

/** Maps polaris OIDC claims (scope `openid email phone`, no profile) to a User. */
export function polarisUser(claims: Record<string, unknown>) {
	const phoneNumber =
		typeof claims.phone_number === "string" ? claims.phone_number : null;
	const user = {
		email:
			typeof claims.email === "string" && claims.email
				? claims.email
				: `${claims.sub}${PLACEHOLDER_DOMAIN}`,
		// merge into a same-email User only when polaris vouches for the email
		emailVerified: claims.email_verified === true,
		phoneNumber,
	};
	return { ...user, name: displayName(user) };
}

/** Admins always; Members only via the instance switch, unless no OIDC is configured. */
export function canUsePassword(
	user: { role?: string | null } | null | undefined,
	policy: { oidcConfigured: boolean; allowMemberPassword: boolean },
) {
	return isAdmin(user) || !policy.oidcConfigured || policy.allowMemberPassword;
}

/** Startup entry point of Instance Setup: uses ADMIN_EMAIL/ADMIN_PASSWORD when both are set. */
export async function bootstrapDefaultAdmin(
	env: { ADMIN_EMAIL?: string; ADMIN_PASSWORD?: string },
	setupInstance: (admin: {
		email: string;
		password: string;
	}) => Promise<boolean>,
) {
	if (!env.ADMIN_EMAIL || !env.ADMIN_PASSWORD) return false;
	return setupInstance({
		email: env.ADMIN_EMAIL,
		password: env.ADMIN_PASSWORD,
	});
}
