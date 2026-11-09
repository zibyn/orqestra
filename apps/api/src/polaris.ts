import { accessTokenVerifier, createPolaris } from "@zibyn/polaris";
import type { Auth, Session } from "./app.ts";
import { toUser } from "./identity.ts";

export type PolarisEnv = {
	// Where Orqestra is served; Polaris redirects back to {ORQESTRA_URL}/auth/callback
	ORQESTRA_URL: string;
	POLARIS_ISSUER: string;
	POLARIS_CLIENT_ID: string;
	POLARIS_CLIENT_SECRET: string;
	// The access tokens' aud: the Application's default API at Polaris, where Roles grant `orqestra:admin`
	POLARIS_AUDIENCE: string;
	POLARIS_SECRET: string;
};

/** The session reader and /auth/* handler backed by Polaris, which owns the User pool. */
export function polaris(env: PolarisEnv): { session: Session; auth: Auth } {
	const sdk = createPolaris({
		issuer: env.POLARIS_ISSUER,
		clientId: env.POLARIS_CLIENT_ID,
		clientSecret: env.POLARIS_CLIENT_SECRET,
		baseURL: env.ORQESTRA_URL,
		secret: env.POLARIS_SECRET,
	});
	const verifyAccessToken = accessTokenVerifier({
		issuer: env.POLARIS_ISSUER,
		audience: env.POLARIS_AUDIENCE,
	});
	return {
		auth: sdk.handler,
		async session(request) {
			const { session, headers } = await sdk.getSession(request);
			const cookies = headers.getSetCookie();
			if (!session) return { user: null, cookies };
			const { entitlements } = await verifyAccessToken(
				session.accessToken,
			).catch((err) => {
				// The SDK's message hides which check failed (aud, iss, typ…); a misconfigured Application shows here
				console.error("Polaris access token refused:", err.cause ?? err);
				throw err;
			});
			return { user: toUser(session.user, entitlements), cookies };
		},
	};
}
