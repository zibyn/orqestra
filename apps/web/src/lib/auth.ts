import { db } from "@orqestra/db";
import * as schema from "@orqestra/db/schema";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError } from "better-auth/api";
import { admin, genericOAuth } from "better-auth/plugins";
import { tanstackStartCookies } from "better-auth/tanstack-start";
import { env } from "#/env";
import { canUsePassword, polarisUser } from "#/lib/identity";

export const oidc = {
	configured: Boolean(env.OIDC_ISSUER && env.OIDC_CLIENT_ID),
	issuer: env.OIDC_ISSUER?.replace(/\/$/, ""),
};

export async function getAllowMemberPassword() {
	const [row] = await db.select().from(schema.instanceSettings);
	return row?.allowMemberPassword ?? false;
}

export async function setAllowMemberPassword(allowMemberPassword: boolean) {
	await db
		.insert(schema.instanceSettings)
		.values({ allowMemberPassword })
		.onConflictDoUpdate({
			target: schema.instanceSettings.id,
			set: { allowMemberPassword },
		});
}

export const auth = betterAuth({
	database: drizzleAdapter(db, { provider: "pg", schema }),
	emailAndPassword: { enabled: true, disableSignUp: true },
	user: {
		additionalFields: {
			phoneNumber: { type: "string", required: false, input: false },
		},
	},
	// Merging is decided by polaris' email_verified alone (see polarisUser)
	account: { accountLinking: { requireLocalEmailVerified: false } },
	databaseHooks: {
		session: {
			create: {
				// Runs after the password is verified, so it does not reveal which emails are Members
				before: async (session, ctx) => {
					if (ctx?.path !== "/sign-in/email") return;
					const user = (await ctx.context.internalAdapter.findUserById(
						session.userId,
					)) as { role?: string } | null;
					const allowed = canUsePassword(user?.role, {
						oidcConfigured: oidc.configured,
						allowMemberPassword: await getAllowMemberPassword(),
					});
					if (!allowed)
						throw new APIError("FORBIDDEN", {
							message: "Password login is disabled. Sign in with Polaris.",
						});
				},
			},
		},
	},
	plugins: [
		admin(),
		genericOAuth({
			config: oidc.configured
				? [
						{
							providerId: "polaris",
							name: "Polaris",
							discoveryUrl: `${oidc.issuer}/.well-known/openid-configuration`,
							clientId: env.OIDC_CLIENT_ID as string,
							clientSecret: env.OIDC_CLIENT_SECRET,
							scopes: ["openid", "email", "phone"],
							pkce: true,
							postLogoutRedirectURI: "/login",
							mapProfileToUser: polarisUser,
						},
					]
				: [],
		}),
		tanstackStartCookies(),
	],
});

export const admins = {
	hasAdmin: async () =>
		Boolean(
			await db.query.user.findFirst({
				where: (u, { eq }) => eq(u.role, "admin"),
			}),
		),
	createAdmin: async (email: string, password: string) => {
		await auth.api.createUser({
			body: { email, password, name: email, role: "admin" },
		});
	},
};
