// A User's Connection to a per-User OAuth MCP Server: finding its authorization server, and the authorization that makes the Connection.
// The SDK does discovery, PKCE, the authorization URL, the code exchange and the `iss` check; Orqestra keeps the state.
import {
	type AuthProvider,
	auth,
	discoverAuthorizationServerMetadata,
	discoverOAuthProtectedResourceMetadata,
	extractWWWAuthenticateParams,
	type OAuthClientMetadata,
	type OAuthClientProvider,
	type OAuthDiscoveryState,
	OAuthError,
	type OAuthTokens,
	refreshAuthorization,
	type StoredOAuthClientInformation,
	UnauthorizedError,
	validateAuthorizationResponseIssuer,
} from "@modelcontextprotocol/client";
import type { Fetch, McpServer } from "./index.ts";

/** The step of finding a per-User OAuth server's authorization server that failed. */
export type OAuthDiscoveryStep =
	| "resource_metadata"
	| "authorization_server_metadata"
	| "pkce";

/**
 * A Connection's tokens, with when the access token expires (ms since the epoch) worked out when they came, and the client_id of the
 * Client they were issued to, which refreshes them.
 */
export type ConnectionTokens = OAuthTokens & {
	expires_at?: number;
	client_id?: string;
};

const withExpiry = (
	tokens: OAuthTokens,
	client_id: string,
): ConnectionTokens => ({
	...tokens,
	client_id,
	...(tokens.expires_in !== undefined && {
		expires_at: Date.now() + tokens.expires_in * 1000,
	}),
});

/** What a refresh changes of a Connection: new tokens, or that it needs reconnecting. */
export type ConnectionChange =
	| { tokens: ConnectionTokens; scope?: string }
	| { status: "needs_reconnect" };

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
	/**
	 * Runs `fn` holding the lock of the User's Connection, so processes refresh it one at a time, with the Connection as stored once the
	 * lock is held; `change` writes it before the lock is let go.
	 */
	lockConnection<T>(
		userId: string,
		serverId: string,
		fn: (
			connection: StoredConnection | undefined,
			change: (change: ConnectionChange) => Promise<void>,
		) => Promise<T>,
	): Promise<T>;
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
	/** Forgets it, for its authorization server no longer knows it. */
	deleteRegisteredClient(serverId: string): Promise<void>;
}

/**
 * How a Run sends the User's own token to a per-User OAuth MCP Server, read once as the Run starts; undefined when the User has no
 * Connection to it, it needs reconnecting, or its tokens no longer decrypt. A 401 refreshes the tokens, holding the Connection's lock;
 * when another process refreshed them meanwhile, theirs are used. A refresh the authorization server refuses (or no refresh token)
 * fails the call and leaves the Connection needing reconnecting.
 */
export async function connectionAuth(
	store: ConnectionStore,
	userId: string,
	serverId: string,
	{
		server,
		fetch = globalThis.fetch,
	}: {
		server: Pick<McpServer, "url" | "headers" | "oauthClient">;
		fetch?: Fetch;
	},
): Promise<AuthProvider | undefined> {
	const connection = await store.connection(userId, serverId);
	let token =
		connection?.status === "connected"
			? connection.tokens?.access_token
			: undefined;
	if (token === undefined) return undefined;
	// read outside the lock: a Run waiting for it holds a database connection, the holder must not need another
	const registered = await store.registeredClient(serverId);
	// the refresh runs holding the lock, so it may not hang
	const timed: Fetch = (input, init) =>
		fetch(input, {
			...init,
			signal: AbortSignal.any([
				AbortSignal.timeout(30_000),
				...(init?.signal ? [init.signal] : []),
			]),
		});
	return {
		token: async () => token,
		async onUnauthorized() {
			const sent = token;
			let forgetClient = false;
			token = await store.lockConnection(
				userId,
				serverId,
				async (current, change) => {
					const tokens =
						current?.status === "connected" ? current.tokens : undefined;
					if (!tokens) return undefined;
					if (tokens.access_token !== sent) return tokens.access_token;
					const reconnect = async () => {
						await change({ status: "needs_reconnect" });
						return undefined;
					};
					const { refresh_token, client_id = "" } = tokens;
					if (!refresh_token) return reconnect();
					const discovery = await discoverAuthorization(server, timed);
					const metadata = discovery.authorizationServerMetadata;
					// tokens of an authorization server the server no longer names
					if (
						(metadata?.issuer ?? discovery.authorizationServerUrl) !==
						current?.issuer
					)
						return reconnect();
					const client = [server.oauthClient, registered].find(
						(c) => c?.client_id === client_id,
					);
					try {
						const refreshed = withExpiry(
							await refreshAuthorization(discovery.authorizationServerUrl, {
								metadata,
								// the Client ID Metadata Document is a public Client: its client_id is all there is
								clientInformation: client ?? { client_id },
								refreshToken: refresh_token,
								resource: discovery.resourceMetadata?.resource,
								fetchFn: timed,
							}),
							client_id,
						);
						await change({ tokens: refreshed, scope: refreshed.scope });
						return refreshed.access_token;
					} catch (error) {
						if (!(error instanceof OAuthError)) throw error;
						if (
							error.code === "invalid_client" ||
							error.code === "unauthorized_client"
						)
							// only the one Orqestra registered: a pre-registered Client is the Admin's, the Metadata Document Orqestra's own
							forgetClient = client !== undefined && client === registered;
						else if (error.code !== "invalid_grant") throw error;
						return reconnect();
					}
				},
			);
			if (forgetClient) await store.deleteRegisteredClient(serverId);
			if (token === undefined)
				throw new UnauthorizedError(
					`The Connection to MCP Server "${serverId}" needs reconnecting`,
				);
		},
	};
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
				tokens: withExpiry(tokens, pending.client.client_id),
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

/** How long revoking one Connection may take in all, discovery included. */
export const REVOKE_TIMEOUT_MS = 5_000;

/**
 * Revokes a deleted Connection at its authorization server (RFC 7009): its refresh token, else its access token, as the Client it was
 * most likely made as (pre-registered, the one registered with that issuer, else the Client ID Metadata Document). Nothing when the
 * authorization server has no `revocation_endpoint`; throws when revoking fails, for the caller to log.
 */
export async function revokeConnection(
	{ tokens, issuer }: { tokens: ConnectionTokens; issuer: string },
	{
		oauthClient,
		registered,
		orqestraUrl,
	}: {
		oauthClient?: McpServer["oauthClient"];
		registered?: StoredOAuthClientInformation;
		/** Unknown: no Client ID Metadata Document. */
		orqestraUrl?: string;
	},
	fetch: Fetch = globalThis.fetch,
): Promise<void> {
	const signal = AbortSignal.timeout(REVOKE_TIMEOUT_MS);
	const timed: Fetch = (input, init) => fetch(input, { ...init, signal });
	const metadata = await discoverAuthorizationServerMetadata(issuer, {
		fetchFn: timed,
	});
	// RFC 8414 lists it; the SDK's OpenID Connect type does not, though such metadata may carry it too
	const endpoint = (metadata as { revocation_endpoint?: string } | undefined)
		?.revocation_endpoint;
	if (!endpoint) return;
	const client =
		oauthClient ??
		(registered?.issuer === issuer ? registered : undefined) ??
		(orqestraUrl && new URL(orqestraUrl).protocol === "https:"
			? { client_id: clientMetadataUrl(orqestraUrl) }
			: undefined);
	const body = new URLSearchParams(
		tokens.refresh_token
			? { token: tokens.refresh_token, token_type_hint: "refresh_token" }
			: { token: tokens.access_token, token_type_hint: "access_token" },
	);
	const headers: Record<string, string> = {
		"content-type": "application/x-www-form-urlencoded",
	};
	// a confidential Client authenticates by HTTP Basic (RFC 6749 §2.3.1), a public one names itself
	if (client?.client_secret)
		headers.authorization = `Basic ${btoa(`${encodeURIComponent(client.client_id)}:${encodeURIComponent(client.client_secret)}`)}`;
	else if (client) body.set("client_id", client.client_id);
	const response = await timed(endpoint, { method: "POST", headers, body });
	await response.body?.cancel();
	if (!response.ok) throw new Error(`${endpoint} answered ${response.status}`);
}
