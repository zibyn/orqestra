// Pure identity rules, kept free of DB/auth imports so they unit-test without a database.

/** Held at Orqestra's API in Polaris by Admins; everyone else who may sign in is a Member. */
export const ADMIN_ENTITLEMENT = "orqestra:admin";

export type User = { id: string; name: string; admin: boolean };

/** The signed-in User from the ID token's claims and the access token's Entitlements. */
export function toUser(
	claims: { sub: string; [claim: string]: unknown },
	entitlements: string[],
): User {
	const text = (claim: unknown) =>
		typeof claim === "string" && claim ? claim : undefined;
	return {
		id: claims.sub,
		// The name the User gave themselves, then how they sign in; the sub only when Polaris sends none
		name:
			text(claims.name) ??
			text(claims.nickname) ??
			text(claims.preferred_username) ??
			text(claims.email) ??
			text(claims.phone_number) ??
			claims.sub,
		admin: entitlements.includes(ADMIN_ENTITLEMENT),
	};
}
