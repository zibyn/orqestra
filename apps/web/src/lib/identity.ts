// Pure identity rules, kept free of DB/auth imports so they unit-test without a database.

type Admins = {
	hasAdmin: () => Promise<boolean>;
	createAdmin: (email: string, password: string) => Promise<void>;
};

/** Instance Setup: creates the Default Admin unless any Admin exists. Returns whether it ran. */
export async function setupInstance(
	admins: Admins,
	{ email, password }: { email: string; password: string },
) {
	// shortcut: check-then-create is not atomic; two simultaneous first-boot setups could both win. Add a DB lock if setup is ever exposed beyond first boot.
	if (await admins.hasAdmin()) return false;
	await admins.createAdmin(email, password);
	return true;
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
	role: string | null | undefined,
	s: { oidcConfigured: boolean; allowMemberPassword: boolean },
) {
	return role === "admin" || !s.oidcConfigured || s.allowMemberPassword;
}

/** Startup entry point of Instance Setup: uses ADMIN_EMAIL/ADMIN_PASSWORD when both are set. */
export async function bootstrapDefaultAdmin(
	env: { ADMIN_EMAIL?: string; ADMIN_PASSWORD?: string },
	admins: Admins,
) {
	if (!env.ADMIN_EMAIL || !env.ADMIN_PASSWORD) return false;
	return setupInstance(admins, {
		email: env.ADMIN_EMAIL,
		password: env.ADMIN_PASSWORD,
	});
}
