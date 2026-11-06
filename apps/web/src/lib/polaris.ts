import { accessTokenVerifier, createPolaris } from "@zibyn/polaris";
import { env } from "#/env";

// Server only: Polaris owns the User pool; Orqestra keeps only data keyed by the User's `sub`
export const polaris = createPolaris({
	issuer: env.POLARIS_ISSUER,
	clientId: env.POLARIS_CLIENT_ID,
	clientSecret: env.POLARIS_CLIENT_SECRET,
	baseURL: env.ORQESTRA_URL,
	secret: env.POLARIS_SECRET,
});

// The Application's default API at Polaris; the session's access token is issued for it
export const verifyAccessToken = accessTokenVerifier({
	issuer: env.POLARIS_ISSUER,
	audience: env.POLARIS_API,
});
