import { db } from "@orqestra/db";
import * as schema from "@orqestra/db/schema";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import {
	APIError,
	createAuthMiddleware,
	getSessionFromCtx,
} from "better-auth/api";
import { admin, genericOAuth } from "better-auth/plugins";
import { tanstackStartCookies } from "better-auth/tanstack-start";
import { eq } from "drizzle-orm";
import { env } from "#/env";
import { canUsePassword, isAdmin, polarisUser } from "#/lib/identity";

export const oidc = {
	configured: Boolean(
		env.OIDC_ISSUER && env.OIDC_CLIENT_ID && env.OIDC_CLIENT_SECRET,
	),
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

/** Inputs of the password login rule (see canUsePassword). */
export async function passwordPolicy() {
	return {
		oidcConfigured: oidc.configured,
		allowMemberPassword: await getAllowMemberPassword(),
	};
}

export const auth = betterAuth({
	database: drizzleAdapter(db, { provider: "pg", schema }),
	trustedOrigins: env.BETTER_AUTH_TRUSTED_ORIGINS,
	emailAndPassword: { enabled: true, disableSignUp: true },
	user: {
		additionalFields: {
			// Not input:false, which would drop it from the polaris profile; the /update-user guard below keeps users from setting it
			phoneNumber: { type: "string", required: false },
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
					const user = await db.query.user.findFirst({
						where: (u, { eq }) => eq(u.id, session.userId),
					});
					if (!canUsePassword(user, await passwordPolicy()))
						throw new APIError("FORBIDDEN", {
							message: "Password login is disabled. Sign in with Polaris.",
						});
				},
			},
		},
	},
	hooks: {
		before: createAuthMiddleware(async (ctx) => {
			if (ctx.path === "/update-user" && ctx.body?.phoneNumber !== undefined)
				throw new APIError("BAD_REQUEST", {
					message: "The phone number comes from Polaris",
				});
			// Keeps at least one Admin; better-auth itself already refuses self-ban and self-removal
			if (ctx.path === "/admin/set-role" || ctx.path === "/admin/update-user") {
				const role = ctx.body?.role ?? ctx.body?.data?.role;
				if (role === undefined || isAdmin({ role })) return;
				const session = await getSessionFromCtx(ctx);
				if (session?.user.id === ctx.body.userId)
					throw new APIError("BAD_REQUEST", {
						message: "You cannot demote yourself",
					});
			}
		}),
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

export async function isSetupCompleted() {
	const [row] = await db.select().from(schema.instanceSettings);
	return row?.setupCompleted ?? false;
}

/** Instance Setup: atomically marks setup done and creates the Default Admin. False if it already ran. */
export async function setupInstance({
	email,
	password,
}: {
	email: string;
	password: string;
}) {
	return db.transaction(async (tx) => {
		// Concurrent claims wait on this row's lock, then see setup_completed already true
		const claimed = await tx
			.insert(schema.instanceSettings)
			.values({ setupCompleted: true })
			.onConflictDoUpdate({
				target: schema.instanceSettings.id,
				set: { setupCompleted: true },
				setWhere: eq(schema.instanceSettings.setupCompleted, false),
			})
			.returning();
		if (claimed.length === 0) return false;
		// Not on tx, but if it throws the claim above rolls back
		await auth.api.createUser({
			body: { email, password, name: email, role: "admin" },
		});
		return true;
	});
}
