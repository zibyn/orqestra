// An Integration Installation (ADR 0018, 0020): Orqestra's app installed by an Admin into one workspace of a WorkSource, acting as
// itself, by OAuth (actor=app), its tokens kept fresh, or by the credentials the Integration gave the Admin, traded for a token when the
// source needs one; the queue its events wait in for the worker, and the connection the worker holds for a source that pushes them down
// one. One per kind.
import { randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { db } from "@orqestra/db";
import { integrationInstallation as installation } from "@orqestra/db/schema";
import {
	decryptSecret,
	encryptSecret,
	secretReadable,
} from "@orqestra/db/secret";
import { createPostgresBackend, Queue, Worker } from "bullmq";
import { and, eq, gt } from "drizzle-orm";
import { z } from "zod";
import type {
	Activity,
	Auth,
	Credentials,
	Fetch,
	SessionEvent,
	WorkSource,
} from "./ports.ts";

/** How long the Admin has at the authorization page. */
const PENDING_TTL_MS = 10 * 60_000;

/** An access token is refreshed, or traded again, once it expires within this. */
const REFRESH_MARGIN_MS = 60_000;

/**
 * How often the worker checks the app's tokens. Linear's access token lasts 24 hours and comes with its refresh token, so a daily check
 * refreshes each refresh token within 2 days of its issue, far inside the 30 days after which it lapses however much it was used.
 */
const TOKEN_CHECK_EVERY_MS = 24 * 3_600_000;

/** How often a held connection looks for the Admin saving other credentials, or for the app being installed. */
const STREAM_CHECK_EVERY_MS = 10_000;

/** After a held connection throws, it connects again after a second, then twice as long each time it throws again, up to this. */
const STREAM_BACKOFF_MAX_MS = 5 * 60_000;

export const installationInput = z.object({
	clientId: z.string().trim().min(1),
	// blank keeps the stored one
	clientSecret: z.string().trim().optional(),
	webhookSecret: z.string().trim().optional(),
});

/** A credentials install's fields by name, as the Admin entered them; a secret left blank keeps the stored one. */
export const credentialsInput = z.record(z.string(), z.string().trim());

/** Where the WorkSource sends the Admin back to, the OAuth app's callback URL. */
export const callbackUrl = (source: WorkSource, orqestraUrl: string) =>
	new URL(`/api/${source.kind}/callback`, orqestraUrl).href;

/** Where the WorkSource sends the app's webhooks. */
export const webhookUrl = (source: WorkSource, orqestraUrl: string) =>
	new URL(`/api/${source.kind}/webhook`, orqestraUrl).href;

export const conversationsInput = z.object({
	defaultAgentId: z.string().min(1),
	scopeRepos: z.record(
		z.string().trim().min(1),
		z
			.string()
			.trim()
			.regex(/^[\w.-]+\/[\w.-]+$/, "must be owner/repo"),
	),
	// left out keeps the stored ones
	openScopes: z.array(z.string().trim().min(1)).optional(),
});

const ofKind = (source: WorkSource) => eq(installation.kind, source.kind);

/** The source's OAuth install: a credentials install has no authorization to start, nor tokens to grant or refresh. */
const oauthOf = (source: WorkSource) => {
	if (source.install.mode !== "oauth")
		throw new Error(`${source.name} installs by credentials, not OAuth`);
	return source.install;
};

const credentialsOf = (source: WorkSource) => {
	if (source.install.mode !== "credentials")
		throw new Error(`${source.name} installs by OAuth, not credentials`);
	return source.install;
};

/** Postgres' foreign_key_violation, as drizzle passes it on. */
const missingReference = (error: unknown) =>
	(error as { cause?: { code?: string } }).cause?.code === "23503";

/** Saves the Agent of the Conversations the app opens, the repository each scope's work is done in and the scopes opened to shared sessions; refused until the app's credentials are saved. */
export async function saveConversations(
	source: WorkSource,
	input: z.infer<typeof conversationsInput>,
): Promise<{
	errors: Partial<Record<"defaultAgentId" | "", { code: "not_found" }>>;
}> {
	try {
		const [row] = await db
			.update(installation)
			.set(input)
			.where(ofKind(source))
			.returning({ kind: installation.kind });
		return { errors: row ? {} : { "": { code: "not_found" } } };
	} catch (error) {
		// the Agent's row is agents' to read: its foreign key says it is gone
		if (missingReference(error))
			return { errors: { defaultAgentId: { code: "not_found" } } };
		throw error;
	}
}

type Tokens = {
	accessToken: string;
	refreshToken: string;
	/** Ms since the epoch. */
	expiresAt: number;
};

/** A token a credentials install traded for its credentials, cached until it expires. */
type TradedToken = { accessToken: string; expiresAt: number };

const sealed = (value: Tokens | TradedToken | Credentials) =>
	encryptSecret(JSON.stringify(value));
/** A stored JSON secret, decrypted; undefined when there is none, or it no longer decrypts. */
const opened = <T>(stored: string | null | undefined): T | undefined => {
	const plain = stored ? decryptSecret(stored) : undefined;
	return plain === undefined ? undefined : JSON.parse(plain);
};
const readable = (stored: string | null) => !!stored && secretReadable(stored);
const plainSecret = (stored: string | null) =>
	(stored ? decryptSecret(stored) : undefined) ?? "";

/** The installation as the console shows it, or null; secrets and tokens only go in. `workspace` is null until it is installed. */
export async function installationStatus(source: WorkSource) {
	const row = await db.query.integrationInstallation.findFirst({
		where: ofKind(source),
	});
	return row
		? {
				clientId: row.clientId,
				defaultAgentId: row.defaultAgentId,
				scopeRepos: row.scopeRepos,
				clientSecretReadable: readable(row.clientSecret),
				webhookSecretReadable: readable(row.webhookSecret),
				// tokens that no longer decrypt need installing again
				workspace: readable(row.tokens) ? row.workspace : null,
				needsReinstall: row.needsReinstall,
			}
		: null;
}

/**
 * A credentials install as the console shows it: each field the Admin enters, a secret one only as whether one is stored that still
 * decrypts; and once it is saved, its workspace (null when its credentials no longer decrypt) and the Conversations it opens.
 */
export async function credentialsStatus(source: WorkSource) {
	const { fields } = credentialsOf(source);
	const row = await db.query.integrationInstallation.findFirst({
		where: ofKind(source),
	});
	const stored = opened<Credentials>(row?.credentials);
	return {
		fields: fields.map(({ name, secret }) => ({
			name,
			secret,
			value: (!secret && stored?.[name]) || "",
			readable: !!stored?.[name],
		})),
		installation: row
			? {
					workspace: stored ? row.workspace : null,
					defaultAgentId: row.defaultAgentId,
					scopeRepos: row.scopeRepos,
					openScopes: row.openScopes,
				}
			: null,
	};
}

/** The Agent, the repository of each scope and the scopes opened to shared sessions, for the Conversations the app opens. */
export async function conversationSettings(source: WorkSource) {
	return db.query.integrationInstallation.findFirst({
		where: ofKind(source),
		columns: { defaultAgentId: true, scopeRepos: true, openScopes: true },
	});
}

export type CredentialsError =
	| { code: "secret_required" | "required" }
	| { code: "credentials_refused"; detail: string };

/**
 * Saves a credentials install's fields once the Integration accepts them, a secret left blank keeping the stored one: the token they
 * trade for, cached, and the name of the workspace they are for. Errors by field, or on "" when the Integration refused them.
 */
export async function saveCredentials(
	source: WorkSource,
	input: Credentials,
	{ fetch = globalThis.fetch }: { fetch?: Fetch } = {},
): Promise<{ errors: Partial<Record<string, CredentialsError>> }> {
	const install = credentialsOf(source);
	const row = await db.query.integrationInstallation.findFirst({
		where: ofKind(source),
		columns: { credentials: true },
	});
	const stored = opened<Credentials>(row?.credentials) ?? {};
	const credentials: Credentials = {};
	const errors: Record<string, CredentialsError> = {};
	for (const { name, secret } of install.fields) {
		const value = input[name] || (secret ? stored[name] : undefined);
		if (value) credentials[name] = value;
		else errors[name] = { code: secret ? "secret_required" : "required" };
	}
	if (Object.keys(errors).length) return { errors };
	let token: TradedToken | undefined;
	let workspace: string;
	try {
		token = await install.token?.(credentials, fetch);
		workspace = await install.workspace(
			{ token: token?.accessToken ?? "", credentials },
			fetch,
		);
	} catch (error) {
		return {
			errors: {
				"": {
					code: "credentials_refused",
					detail: error instanceof Error ? error.message : String(error),
				},
			},
		};
	}
	const values = {
		credentials: sealed(credentials),
		tokens: token ? sealed(token) : null,
		workspace,
		needsReinstall: false,
	};
	await db
		.insert(installation)
		.values({ kind: source.kind, ...values })
		.onConflictDoUpdate({ target: installation.kind, set: values });
	return { errors: {} };
}

/**
 * Saves the app's credentials and starts installing it: the URL to send the Admin to, valid for PENDING_TTL_MS and voiding any earlier
 * one. Another client_id forgets the installation of the app it replaces.
 */
export async function startInstallation(
	source: WorkSource,
	input: z.infer<typeof installationInput>,
	orqestraUrl: string,
): Promise<{
	errors: Partial<
		Record<"clientSecret" | "webhookSecret", { code: "secret_required" }>
	>;
	url?: string;
}> {
	const install = oauthOf(source);
	const stored = await db.query.integrationInstallation.findFirst({
		where: ofKind(source),
	});
	const keep = (secret: string | null | undefined) =>
		secret && secretReadable(secret) ? secret : undefined;
	const clientSecret = input.clientSecret
		? encryptSecret(input.clientSecret)
		: keep(stored?.clientSecret);
	const webhookSecret = input.webhookSecret
		? encryptSecret(input.webhookSecret)
		: keep(stored?.webhookSecret);
	if (!clientSecret || !webhookSecret)
		return {
			errors: {
				...(!clientSecret && { clientSecret: { code: "secret_required" } }),
				...(!webhookSecret && { webhookSecret: { code: "secret_required" } }),
			},
		};
	const state = randomBytes(32).toString("base64url");
	const values = {
		clientId: input.clientId,
		clientSecret,
		webhookSecret,
		pendingState: state,
		pendingAt: new Date(),
		...(stored?.clientId !== input.clientId && {
			tokens: null,
			workspace: null,
			needsReinstall: false,
		}),
	};
	await db
		.insert(installation)
		.values({ kind: source.kind, ...values })
		.onConflictDoUpdate({ target: installation.kind, set: values });
	const url = new URL(install.authorize.url);
	url.search = new URLSearchParams({
		client_id: input.clientId,
		redirect_uri: callbackUrl(source, orqestraUrl),
		response_type: "code",
		scope: install.authorize.scope,
		state,
		...install.authorize.params,
	}).toString();
	return { errors: {}, url: url.href };
}

export type FinishInstallationError = "state_invalid" | "denied" | "failed";

/**
 * The redirect back (`code` and `state`, or `error`): installs the app when it answers the authorization last started, within
 * PENDING_TTL_MS and once, storing its tokens and the workspace's name.
 */
export async function finishInstallation(
	source: WorkSource,
	query: URLSearchParams,
	{
		orqestraUrl,
		fetch = globalThis.fetch,
	}: { orqestraUrl: string; fetch?: Fetch },
): Promise<FinishInstallationError | undefined> {
	const state = query.get("state");
	if (!state || source.install.mode !== "oauth") return "state_invalid";
	const install = source.install;
	// taken in the statement that reads it, so two callbacks with one state install once
	const [taken] = await db
		.update(installation)
		.set({ pendingState: null, pendingAt: null })
		.where(
			and(
				ofKind(source),
				eq(installation.pendingState, state),
				gt(installation.pendingAt, new Date(Date.now() - PENDING_TTL_MS)),
			),
		)
		.returning();
	if (!taken) return "state_invalid";
	const code = query.get("code");
	if (!code) return "denied";
	const clientId = taken.clientId ?? "";
	try {
		const tokens = await tokenRequest(source, fetch, {
			grant_type: "authorization_code",
			code,
			redirect_uri: callbackUrl(source, orqestraUrl),
			client_id: clientId,
			client_secret: plainSecret(taken.clientSecret),
		});
		const workspace = await install.workspace(tokens.accessToken, fetch);
		await db
			.update(installation)
			.set({ tokens: sealed(tokens), workspace, needsReinstall: false })
			// not over the app of an installation started since
			.where(and(ofKind(source), eq(installation.clientId, clientId)));
		return undefined;
	} catch (error) {
		console.error(`Installing the ${source.name} app failed`, error);
		return "failed";
	}
}

/** A token endpoint refused a grant (RFC 6749 5.2: 400 such as invalid_grant, or 401 invalid_client): sending it again will not help. */
export class GrantRefused extends Error {
	override name = "GrantRefused";
}

/**
 * An OAuth install's access token, refreshed first when it is about to expire; undefined when the app is not installed or its tokens
 * no longer decrypt. Holds the installation's row lock, so processes refresh one at a time. Throws GrantRefused when the refresh is
 * refused, having marked the installation as needing a reinstall; a refresh that succeeds clears that.
 */
export async function accessToken(
	source: WorkSource,
	{ fetch = globalThis.fetch }: { fetch?: Fetch } = {},
) {
	oauthOf(source);
	const token = await db.transaction(async (tx) => {
		const [row] = await tx
			.select()
			.from(installation)
			.where(ofKind(source))
			.for("update");
		const tokens = opened<Tokens>(row?.tokens);
		if (!row || !tokens) return undefined;
		if (tokens.expiresAt - REFRESH_MARGIN_MS > Date.now())
			return tokens.accessToken;
		try {
			const refreshed = await tokenRequest(source, fetch, {
				grant_type: "refresh_token",
				refresh_token: tokens.refreshToken,
				client_id: row.clientId ?? "",
				client_secret: plainSecret(row.clientSecret),
			});
			await tx
				.update(installation)
				.set({ tokens: sealed(refreshed), needsReinstall: false })
				.where(ofKind(source));
			return refreshed.accessToken;
		} catch (error) {
			if (!(error instanceof GrantRefused)) throw error;
			// returned, not thrown, so the mark commits
			await tx
				.update(installation)
				.set({ needsReinstall: true })
				.where(ofKind(source));
			return error;
		}
	});
	if (token instanceof GrantRefused) throw token;
	return token;
}

/**
 * What the app acts as, for either kind of install: an OAuth install's access token as `accessToken` gives it; a credentials install's
 * credentials, with the token they trade for, cached and traded again once it is about to expire, under the installation's row lock so
 * processes trade one at a time. Undefined when the app is not installed, or what it stored no longer decrypts.
 */
export async function auth(
	source: WorkSource,
	{ fetch = globalThis.fetch }: { fetch?: Fetch } = {},
): Promise<Auth | undefined> {
	const { install } = source;
	if (install.mode === "oauth") {
		const token = await accessToken(source, { fetch });
		return token === undefined ? undefined : { token, credentials: {} };
	}
	return db.transaction(async (tx) => {
		const [row] = await tx
			.select()
			.from(installation)
			.where(ofKind(source))
			.for("update");
		const credentials = opened<Credentials>(row?.credentials);
		if (!credentials) return undefined;
		if (!install.token) return { token: "", credentials };
		const cached = opened<TradedToken>(row.tokens);
		if (cached && cached.expiresAt - REFRESH_MARGIN_MS > Date.now())
			return { token: cached.accessToken, credentials };
		const traded = await install.token(credentials, fetch);
		await tx
			.update(installation)
			.set({ tokens: sealed(traded) })
			.where(ofKind(source));
		return { token: traded.accessToken, credentials };
	});
}

const tokenResponse = z.object({
	access_token: z.string(),
	refresh_token: z.string(),
	expires_in: z.number(),
});

/** A grant at an OAuth install's token endpoint: the installation's tokens. */
async function tokenRequest(
	source: WorkSource,
	fetch: Fetch,
	params: Record<string, string>,
): Promise<Tokens> {
	const body = tokenResponse.parse(
		await tokenGrant(source, oauthOf(source).tokenUrl, fetch, params),
	);
	return {
		accessToken: body.access_token,
		refreshToken: body.refresh_token,
		expiresAt: Date.now() + body.expires_in * 1000,
	};
}

/** A grant at a token endpoint, which takes only a form: its JSON answer. Throws GrantRefused when the grant is refused. */
export async function tokenGrant(
	source: WorkSource,
	tokenUrl: string,
	fetch: Fetch,
	params: Record<string, string>,
): Promise<unknown> {
	const response = await fetch(tokenUrl, {
		method: "POST",
		headers: {
			"content-type": "application/x-www-form-urlencoded",
			// GitHub answers a form unless asked for JSON
			accept: "application/json",
		},
		body: new URLSearchParams(params),
		signal: AbortSignal.timeout(30_000),
	});
	if (!response.ok) {
		const message = `${source.name}'s token endpoint answered ${response.status}: ${await response.text()}`;
		throw response.status === 400 || response.status === 401
			? new GrantRefused(message)
			: new Error(message);
	}
	return response.json();
}

/** Posts an activity into a session as the app. */
export async function postActivity(
	source: WorkSource,
	sessionId: string,
	activity: Activity,
	{ fetch = globalThis.fetch }: { fetch?: Fetch } = {},
) {
	const as = await auth(source, { fetch });
	if (!as) throw new Error(`The ${source.name} app is not installed`);
	await source.post(as, sessionId, activity, fetch);
}

/**
 * A webhook request's event, when the installation's webhook secret (its own, or its credentials' `webhookSecret`) signed it and it is
 * fresh at `now`: undefined otherwise, and for a source that takes no webhook. Null for a genuine one Orqestra does not act on.
 */
export async function webhookEvent(
	source: WorkSource,
	rawBody: string,
	headers: Headers,
	now = Date.now(),
): Promise<SessionEvent | null | undefined> {
	if (source.ingress.mode !== "webhook") return undefined;
	const row = await db.query.integrationInstallation.findFirst({
		where: ofKind(source),
		columns: { webhookSecret: true, credentials: true },
	});
	const credentials = opened<Credentials>(row?.credentials) ?? {};
	const secret =
		plainSecret(row?.webhookSecret ?? null) || credentials.webhookSecret;
	if (!secret) return undefined;
	return source.ingress.event(rawBody, headers, secret, now, credentials);
}

const connection = () => ({
	connectionString: process.env.DATABASE_URL as string,
	// the api may queue an event before any worker has set up BullMQ's schema
	migrate: true,
});

const newQueue = (name: string) =>
	new Queue(name, { connection: connection() }, createPostgresBackend);
const queues = new Map<string, ReturnType<typeof newQueue>>();
/** Queues an event for the worker; one already queued in the last day, or that failed, is not queued again. */
export async function queueEvent(source: WorkSource, event: SessionEvent) {
	const name = `${source.kind}-events`;
	const queue = queues.get(name) ?? newQueue(name);
	queues.set(name, queue);
	await queue.add("event", event, {
		// BullMQ refuses a job id that is an integer or holds a colon; Linear's pass unchanged
		jobId: /^\d+$/.test(event.id)
			? `n${event.id}`
			: event.id.replaceAll(":", "%3A"),
		// Linear retries a delivery it thinks failed for up to about 7 hours
		removeOnComplete: { age: 86_400 },
		removeOnFail: 1000,
		attempts: 3,
		backoff: { type: "exponential", delay: 2000 },
	});
}

/** Works on queued events one at a time, in the order they were queued (a retried one goes later), until the returned worker is closed. */
export async function serveEvents(
	source: WorkSource,
	handle: (event: SessionEvent) => Promise<void>,
) {
	const worker = new Worker(
		`${source.kind}-events`,
		// shortcut: an event the api queued before 0038 names its session agentSessionId; drop once none can be waiting
		(job) =>
			handle({
				...job.data,
				sessionId: job.data.sessionId ?? job.data.agentSessionId,
			}),
		{ connection: connection() },
		createPostgresBackend,
	);
	worker.on("failed", (job, err) =>
		console.error(`${source.name} event ${job?.id} failed`, err),
	);
	worker.on("error", (err) => console.error("worker error", err));
	await worker.waitUntilReady();
	return worker;
}

/**
 * Refreshes an OAuth install's tokens when due, checking every `every` ms, so a workspace with no session for 30 days keeps its
 * installation; a refusal marks it as needing a reinstall. One schedule however many workers run it, kept in the queue: the first check
 * is when it is first made, and a worker starting again keeps its cadence. Until the returned worker is closed.
 */
export async function serveTokenRefresh(
	source: WorkSource,
	{
		every = TOKEN_CHECK_EVERY_MS,
		fetch,
	}: {
		every?: number;
		fetch?: Fetch;
	} = {},
) {
	oauthOf(source);
	const name = `${source.kind}-tokens`;
	const queue = new Queue(
		name,
		{ connection: connection() },
		createPostgresBackend,
	);
	await queue.upsertJobScheduler(
		name,
		{ every },
		{ name: "refresh", opts: { removeOnComplete: true, removeOnFail: 100 } },
	);
	await queue.close();
	const worker = new Worker(
		name,
		// returns nothing: BullMQ would store a returned token
		async () => {
			await accessToken(source, { fetch });
		},
		{ connection: connection() },
		createPostgresBackend,
	);
	worker.on("failed", (_job, err) =>
		console.error(`Refreshing the ${source.name} app's tokens failed`, err),
	);
	worker.on("error", (err) => console.error("worker error", err));
	await worker.waitUntilReady();
	return worker;
}

/**
 * Holds the app's connection for a source that pushes its events down one, handing each to `onEvent`: connects once the app is
 * installed, again with the new credentials as soon as the Admin saves them (looking every `every` ms), and again after the connection
 * throws, waiting out a backoff that new credentials cut short. Until the returned function is called, which resolves once it is closed.
 */
export function serveStream(
	source: WorkSource,
	onEvent: (event: SessionEvent) => Promise<void>,
	{
		every = STREAM_CHECK_EVERY_MS,
		fetch = globalThis.fetch,
	}: { every?: number; fetch?: Fetch } = {},
) {
	const { ingress } = source;
	if (ingress.mode !== "stream")
		throw new Error(`${source.name} takes its events by webhook`);
	const closed = new AbortController();
	const wait = (ms: number) =>
		sleep(ms, undefined, { signal: closed.signal }).catch(() => {});
	// the credentials as stored: each save encrypts them afresh, so this changes with every save, and only with one
	const stored = (): Promise<string | null> =>
		db.query.integrationInstallation
			.findFirst({ where: ofKind(source), columns: { credentials: true } })
			.then((row) => row?.credentials ?? null);
	// a database that cannot be read changes nothing
	const changed = async (from: string) =>
		(await stored().catch(() => from)) !== from;
	const as = async () => {
		const found = await auth(source, { fetch });
		if (!found) throw new Error(`The ${source.name} app is not installed`);
		return found;
	};
	const held = (async () => {
		let backoff = 0;
		let threwWith: string | null = null;
		while (!closed.signal.aborted) {
			const credentials = await stored().catch((error) => {
				console.error(
					`Reading the ${source.name} app's credentials failed`,
					error,
				);
				return null;
			});
			if (!credentials || opened(credentials) === undefined) {
				await wait(every);
				continue;
			}
			if (credentials !== threwWith) backoff = 0;
			const connection = new AbortController();
			const close = () => connection.abort();
			closed.signal.addEventListener("abort", close);
			const watch = setInterval(async () => {
				if (await changed(credentials)) connection.abort();
			}, every);
			try {
				await ingress.connect(as, onEvent, connection.signal);
			} catch (error) {
				if (!connection.signal.aborted)
					console.error(`The ${source.name} app's connection failed`, error);
			} finally {
				clearInterval(watch);
				closed.signal.removeEventListener("abort", close);
			}
			// it ends only when told to: one that threw, or ended by itself, connects again after the backoff
			threwWith = connection.signal.aborted ? null : credentials;
			if (!threwWith) continue;
			backoff = Math.min(backoff * 2 || 1000, STREAM_BACKOFF_MAX_MS);
			const until = Date.now() + backoff;
			while (!closed.signal.aborted && Date.now() < until) {
				await wait(Math.min(every, until - Date.now()));
				if (await changed(credentials)) break;
			}
		}
	})();
	return async () => {
		closed.abort();
		await held;
	};
}
