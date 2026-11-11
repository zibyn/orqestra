// A User's Connection to a per-User OAuth MCP Server: finding its authorization server, and the authorization that makes the Connection.
// The SDK does discovery, PKCE, the authorization URL, the code exchange and the `iss` check; Orqestra keeps the state.
import {
	auth,
	discoverAuthorizationServerMetadata,
	discoverOAuthProtectedResourceMetadata,
	extractWWWAuthenticateParams,
	type OAuthClientMetadata,
	type OAuthClientProvider,
	type OAuthDiscoveryState,
	type OAuthTokens,
	type StoredOAuthClientInformation,
	validateAuthorizationResponseIssuer,
} from "@modelcontextprotocol/client";
import type { Fetch, McpServer } from "./index.ts";

/** The step of finding a per-User OAuth server's authorization server that failed. */
export type OAuthDiscoveryStep =
	| "resource_metadata"
	| "authorization_server_metadata"
	| "pkce";

/** A Connection's tokens, with when the access token expires (ms since the epoch) worked out when they came. */
export type ConnectionTokens = OAuthTokens & { expires_at?: number };

/** A User's Connection to an MCP Server, as stored; `tokens` is undefined when they no longer decrypt. */
export interface StoredConnection {
	tokens: ConnectionTokens | undefined;
	issuer: string;
	scope: string | null;
	status: "connected" | "needs_reconnect";
	connectedAt: Date;
}

/** An authorization a User started and whose callback has not come back yet; looked up by its `state`. */
export interface PendingAuthorization {
	state: string;
	userId: string;
	serverId: string;
	/** The authorization server it was sent to, which the callback's `iss` must name. */
	issuer: string;
	codeVerifier: string;
	/** The Client it was started as: pre-registered, the Client ID Metadata Document, or registered. */
	client: StoredOAuthClientInformation;
	discovery: OAuthDiscoveryState;
	createdAt: Date;
}

/**
 * Where Connections, pending authorizations and registered Clients are kept, so the api and the worker share them and tests keep them in memory.
 * Secrets in them are the store's to encrypt.
 */
export interface ConnectionStore {
	connection(
		userId: string,
		serverId: string,
	): Promise<StoredConnection | undefined>;
	/** Writes the User's Connection as connected now, replacing theirs. */
	saveConnection(
		userId: string,
		serverId: string,
		connection: { tokens: ConnectionTokens; issuer: string; scope?: string },
	): Promise<void>;
	/** Adds it, voiding the User's earlier ones for the same server (and any older than PENDING_TTL_MS). */
	addPending(pending: PendingAuthorization): Promise<void>;
	/** Removes and returns the one with this state; undefined when there is none. */
	takePending(state: string): Promise<PendingAuthorization | undefined>;
	/** The Client Orqestra registered with the server's authorization server, stamped with that server's issuer; shared by every User. */
	registeredClient(
		serverId: string,
	): Promise<StoredOAuthClientInformation | undefined>;
	/** Replaces it. */
	saveRegisteredClient(
		serverId: string,
		client: StoredOAuthClientInformation & { issuer: string },
	): Promise<void>;
}

/** How long a User has to come back from the authorization server. */
export const PENDING_TTL_MS = 10 * 60_000;

/**
 * Protected Resource Metadata, then its authorization server's metadata with its issuer checked (RFC 8414 §3.3), which must list
 * PKCE S256. Never the origin as the authorization server (2025-03-26), which the SDK would fall back to. `at` hears each step begun.
 */
export async function discoverAuthorization(
	{ url, headers }: Pick<McpServer, "url" | "headers">,
	fetch: Fetch,
	at: (step: OAuthDiscoveryStep) => void = () => {},
): Promise<OAuthDiscoveryState> {
	// the server may name its metadata in the 401 it answers a request without a token with (RFC 9728 §5.1)
	const probe = await fetch(url, {
		method: "POST",
		headers: {
			...headers,
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
		},
		body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "ping" }),
	});
	await probe.body?.cancel();
	at("resource_metadata");
	const resourceMetadataUrl =
		extractWWWAuthenticateParams(probe).resourceMetadataUrl;
	const resourceMetadata = await discoverOAuthProtectedResourceMetadata(
		url,
		{ resourceMetadataUrl },
		fetch,
	);
	const issuer = resourceMetadata.authorization_servers?.[0];
	if (!issuer) throw new Error("No authorization_servers in its metadata");
	at("authorization_server_metadata");
	const authorizationServerMetadata = await discoverAuthorizationServerMetadata(
		issuer,
		{ fetchFn: fetch },
	);
	if (!authorizationServerMetadata)
		throw new Error(`No metadata found for ${issuer}`);
	at("pkce");
	// the SDK goes on when the list is missing; the spec says MUST refuse
	if (
		!authorizationServerMetadata.code_challenge_methods_supported?.includes(
			"S256",
		)
	)
		throw new Error(
			`${issuer} does not list S256 in code_challenge_methods_supported`,
		);
	return {
		authorizationServerUrl: issuer,
		resourceMetadataUrl: resourceMetadataUrl?.href,
		resourceMetadata,
		authorizationServerMetadata,
	};
}

/** One User connecting to one per-User OAuth MCP Server. */
export interface ConnectionContext {
	userId: string;
	serverId: string;
	server: Pick<McpServer, "url" | "headers" | "oauthClient">;
	store: ConnectionStore;
	/** Orqestra's address, `ORQESTRA_URL`: the callback and the Client ID Metadata Document are under it. */
	orqestraUrl: string;
	fetch?: Fetch;
}

export const callbackUrl = (orqestraUrl: string) =>
	new URL("/api/connections/callback", orqestraUrl).href;
const clientMetadataUrl = (orqestraUrl: string) =>
	new URL("/api/connections/client-metadata.json", orqestraUrl).href;

/** Who Orqestra is to an authorization server: also the body of dynamic registration. */
const clientMetadata = (orqestraUrl: string): OAuthClientMetadata => ({
	client_name: "Orqestra",
	redirect_uris: [callbackUrl(orqestraUrl)],
	grant_types: ["authorization_code", "refresh_token"],
	response_types: ["code"],
	token_endpoint_auth_method: "none",
});

/** The Client ID Metadata Document served at its own URL, which is its client_id. */
export const clientMetadataDocument = (orqestraUrl: string) => ({
	client_id: clientMetadataUrl(orqestraUrl),
	...clientMetadata(orqestraUrl),
});

/**
 * The SDK's OAuthClientProvider for one (User, MCP Server), during an authorization: it never opens a browser, the authorization
 * URL is handed back as `authorizationUrl`. Clients in order: pre-registered, the Client ID Metadata Document (when the authorization
 * server takes one and Orqestra is on https: one on plain http could not be fetched), then the registered one, registering when there
 * is none or it is another authorization server's. `pending` resumes an authorization at its callback.
 */
function connectionProvider(
	{ userId, serverId, server, store, orqestraUrl }: ConnectionContext,
	pending: Pick<
		PendingAuthorization,
		"state" | "discovery" | "client" | "codeVerifier"
	>,
) {
	const cimd = new URL(orqestraUrl).protocol === "https:";
	const preRegistered = server.oauthClient;
	let authorizationUrl: URL | undefined;
	const provider: OAuthClientProvider = {
		redirectUrl: callbackUrl(orqestraUrl),
		clientMetadata: clientMetadata(orqestraUrl),
		// the SDK refuses a client_id URL that is not https, even when the authorization server would not use it
		...(cimd && { clientMetadataUrl: clientMetadataUrl(orqestraUrl) }),
		state: () => pending.state,
		discoveryState: () => pending.discovery,
		saveDiscoveryState: (state) => {
			pending.discovery = state;
		},
		async clientInformation({ issuer } = { issuer: "" }) {
			if (pending.client.client_id) return pending.client;
			// the SDK only tries the Client ID Metadata Document when there is no client
			const chosen = preRegistered
				? { ...preRegistered, issuer }
				: cimd &&
						pending.discovery.authorizationServerMetadata
							?.client_id_metadata_document_supported
					? undefined
					: await store.registeredClient(serverId);
			// the callback must exchange the code as the same Client
			if (chosen?.issuer === issuer) pending.client = chosen;
			return chosen;
		},
		async saveClientInformation(client, ctx) {
			pending.client = client;
			if (client.client_id !== provider.clientMetadataUrl && ctx?.issuer)
				await store.saveRegisteredClient(serverId, {
					...client,
					issuer: ctx.issuer,
				});
		},
		// a new authorization is never a refresh
		tokens: () => undefined,
		async saveTokens({ issuer, ...tokens }, ctx) {
			await store.saveConnection(userId, serverId, {
				tokens: {
					...tokens,
					...(tokens.expires_in !== undefined && {
						expires_at: Date.now() + tokens.expires_in * 1000,
					}),
				},
				issuer: issuer ?? ctx?.issuer ?? "",
				scope: tokens.scope,
			});
		},
		redirectToAuthorization: (url) => {
			authorizationUrl = url;
		},
		saveCodeVerifier: (verifier) => {
			pending.codeVerifier = verifier;
		},
		codeVerifier: () => pending.codeVerifier,
	};
	return { provider, authorizationUrl: () => authorizationUrl };
}

export type StartConnectionError =
	| "oauth_unavailable"
	| "oauth_client_required";

/** Starts connecting: the authorization server's URL to send the User to, kept as a pending authorization until its callback. */
export async function startConnection(
	context: ConnectionContext,
): Promise<{ url: string } | { error: StartConnectionError; detail: string }> {
	const fetch = context.fetch ?? globalThis.fetch;
	try {
		const discovery = await discoverAuthorization(context.server, fetch);
		const pending = {
			state: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString(
				"base64url",
			),
			discovery,
			client: { client_id: "" },
			codeVerifier: "",
		};
		const { provider, authorizationUrl } = connectionProvider(context, pending);
		await auth(provider, { serverUrl: context.server.url, fetchFn: fetch });
		const url = authorizationUrl();
		if (!url) throw new Error("The authorization server gave no URL");
		await context.store.addPending({
			...pending,
			userId: context.userId,
			serverId: context.serverId,
			issuer:
				discovery.authorizationServerMetadata?.issuer ??
				discovery.authorizationServerUrl,
			createdAt: new Date(),
		});
		return { url: url.href };
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		return {
			error: /does not support dynamic client registration/.test(detail)
				? "oauth_client_required"
				: "oauth_unavailable",
			detail,
		};
	}
}

export type FinishConnectionError =
	| "state_invalid"
	| "issuer_mismatch"
	| "denied"
	| "failed";

/**
 * The authorization server's redirect back (`code`, `state`, `iss`, or `error`): connects the User when it answers the authorization
 * they started, within PENDING_TTL_MS and once. `serverId` once the state is known.
 */
export async function finishConnection(
	{
		userId,
		store,
		...context
	}: Omit<ConnectionContext, "serverId" | "server"> & {
		/** The MCP Server as configured now; undefined when it is gone. */
		server: (
			serverId: string,
		) => Promise<ConnectionContext["server"] | undefined>;
	},
	query: URLSearchParams,
): Promise<{ serverId?: string; error?: FinishConnectionError }> {
	const pending = await store.takePending(query.get("state") ?? "");
	if (
		!pending ||
		pending.userId !== userId ||
		Date.now() - pending.createdAt.getTime() > PENDING_TTL_MS
	)
		return { error: "state_invalid" };
	const { serverId } = pending;
	const server = await context.server(serverId);
	if (!server) return { serverId, error: "state_invalid" };
	const metadata = pending.discovery.authorizationServerMetadata;
	try {
		// before trusting anything else in it, also an error (RFC 9207); the SDK checks only the code's
		validateAuthorizationResponseIssuer({
			iss: query.get("iss") ?? undefined,
			expectedIssuer: pending.issuer,
			issParameterSupported:
				metadata?.authorization_response_iss_parameter_supported === true,
		});
	} catch {
		return { serverId, error: "issuer_mismatch" };
	}
	const code = query.get("code");
	if (!code) return { serverId, error: "denied" };
	const fetch = context.fetch ?? globalThis.fetch;
	try {
		const { provider } = connectionProvider(
			{ ...context, userId, store, serverId, server },
			pending,
		);
		await auth(provider, {
			serverUrl: server.url,
			authorizationCode: code,
			iss: query.get("iss") ?? undefined,
			fetchFn: fetch,
		});
		return { serverId };
	} catch (error) {
		console.error(
			`Connecting ${userId} to MCP Server "${serverId}" failed`,
			error,
		);
		return { serverId, error: "failed" };
	}
}
