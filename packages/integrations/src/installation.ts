// An Integration Installation (ADR 0018): Orqestra's app installed by an Admin into one workspace of a WorkSource, acting as itself
// (OAuth with actor=app), its tokens kept fresh; the queue its webhook's events wait in for the worker. One per kind.
import { randomBytes } from "node:crypto";
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
import type { Activity, Fetch, SessionEvent, WorkSource } from "./ports.ts";

/** How long the Admin has at the authorization page. */
const PENDING_TTL_MS = 10 * 60_000;

/** An access token is refreshed once it expires within this. */
const REFRESH_MARGIN_MS = 60_000;

/**
 * How often the worker checks the app's tokens. Linear's access token lasts 24 hours and comes with its refresh token, so a daily check
 * refreshes each refresh token within 2 days of its issue, far inside the 30 days after which it lapses however much it was used.
 */
const TOKEN_CHECK_EVERY_MS = 24 * 3_600_000;

export const installationInput = z.object({
	clientId: z.string().trim().min(1),
	// blank keeps the stored one
	clientSecret: z.string().trim().optional(),
	webhookSecret: z.string().trim().optional(),
});

/** Where the WorkSource sends the Admin back to, the OAuth app's callback URL. */
export const callbackUrl = (source: WorkSource, orqestraUrl: string) =>
	new URL(`/api/${source.kind}/callback`, orqestraUrl).href;

/** Where the WorkSource sends the app's webhooks. */
export const webhookUrl = (source: WorkSource, orqestraUrl: string) =>
	new URL(`/api/${source.kind}/webhook`, orqestraUrl).href;

export const conversationsInput = z.object({
	defaultAgentId: z.string().min(1),
	teamRepos: z.record(
		z.string().trim().min(1),
		z
			.string()
			.trim()
			.regex(/^[\w.-]+\/[\w.-]+$/, "must be owner/repo"),
	),
});

const ofKind = (source: WorkSource) => eq(installation.kind, source.kind);

/** Postgres' foreign_key_violation, as drizzle passes it on. */
const missingReference = (error: unknown) =>
	(error as { cause?: { code?: string } }).cause?.code === "23503";

/** Saves the Agent of the Conversations the app opens and the repository each team's issues are worked in; refused until the app's credentials are saved. */
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

const sealed = (tokens: Tokens) => encryptSecret(JSON.stringify(tokens));
const opened = (stored: string): Tokens | undefined => {
	const plain = decryptSecret(stored);
	return plain === undefined ? undefined : JSON.parse(plain);
};

/** The installation as the console shows it, or null; secrets and tokens only go in. `workspace` is null until it is installed. */
export async function installationStatus(source: WorkSource) {
	const row = await db.query.integrationInstallation.findFirst({
		where: ofKind(source),
	});
	return row
		? {
				clientId: row.clientId,
				defaultAgentId: row.defaultAgentId,
				teamRepos: row.teamRepos,
				clientSecretReadable: secretReadable(row.clientSecret),
				webhookSecretReadable: secretReadable(row.webhookSecret),
				// tokens that no longer decrypt need installing again
				workspace:
					row.tokens && secretReadable(row.tokens) ? row.workspace : null,
				needsReinstall: row.needsReinstall,
			}
		: null;
}

/** The Agent and the repository of each team for the Conversations the app opens. */
export async function conversationSettings(source: WorkSource) {
	return db.query.integrationInstallation.findFirst({
		where: ofKind(source),
		columns: { defaultAgentId: true, teamRepos: true },
	});
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
	const stored = await db.query.integrationInstallation.findFirst({
		where: ofKind(source),
	});
	const keep = (secret: string | undefined) =>
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
	const url = new URL(source.authorize.url);
	url.search = new URLSearchParams({
		client_id: input.clientId,
		redirect_uri: callbackUrl(source, orqestraUrl),
		response_type: "code",
		scope: source.authorize.scope,
		state,
		...source.authorize.params,
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
	if (!state) return "state_invalid";
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
	try {
		const tokens = await tokenRequest(source, fetch, {
			grant_type: "authorization_code",
			code,
			redirect_uri: callbackUrl(source, orqestraUrl),
			client_id: taken.clientId,
			client_secret: decryptSecret(taken.clientSecret) ?? "",
		});
		const workspace = await source.workspace(tokens.accessToken, fetch);
		await db
			.update(installation)
			.set({ tokens: sealed(tokens), workspace, needsReinstall: false })
			// not over the app of an installation started since
			.where(and(ofKind(source), eq(installation.clientId, taken.clientId)));
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
 * The app's access token, refreshed first when it is about to expire; undefined when the app is not installed or its tokens no longer
 * decrypt. Holds the installation's row lock, so processes refresh one at a time. Throws GrantRefused when the refresh is refused,
 * having marked the installation as needing a reinstall; a refresh that succeeds clears that.
 */
export async function accessToken(
	source: WorkSource,
	{ fetch = globalThis.fetch }: { fetch?: Fetch } = {},
) {
	const token = await db.transaction(async (tx) => {
		const [row] = await tx
			.select()
			.from(installation)
			.where(ofKind(source))
			.for("update");
		const tokens = row?.tokens ? opened(row.tokens) : undefined;
		if (!row || !tokens) return undefined;
		if (tokens.expiresAt - REFRESH_MARGIN_MS > Date.now())
			return tokens.accessToken;
		try {
			const refreshed = await tokenRequest(source, fetch, {
				grant_type: "refresh_token",
				refresh_token: tokens.refreshToken,
				client_id: row.clientId,
				client_secret: decryptSecret(row.clientSecret) ?? "",
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

const tokenResponse = z.object({
	access_token: z.string(),
	refresh_token: z.string(),
	expires_in: z.number(),
});

/** A grant at the token endpoint, which takes only a form. */
async function tokenRequest(
	source: WorkSource,
	fetch: Fetch,
	params: Record<string, string>,
): Promise<Tokens> {
	const response = await fetch(source.tokenUrl, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams(params),
		signal: AbortSignal.timeout(30_000),
	});
	if (!response.ok) {
		const message = `${source.name}'s token endpoint answered ${response.status}: ${await response.text()}`;
		throw response.status === 400 || response.status === 401
			? new GrantRefused(message)
			: new Error(message);
	}
	const body = tokenResponse.parse(await response.json());
	return {
		accessToken: body.access_token,
		refreshToken: body.refresh_token,
		expiresAt: Date.now() + body.expires_in * 1000,
	};
}

/** Posts an activity into a session as the app. */
export async function postActivity(
	source: WorkSource,
	sessionId: string,
	activity: Activity,
	{ fetch = globalThis.fetch }: { fetch?: Fetch } = {},
) {
	const token = await accessToken(source, { fetch });
	if (!token) throw new Error(`The ${source.name} app is not installed`);
	await source.post(token, sessionId, activity, fetch);
}

/**
 * A webhook request's event, when the installation's webhook secret signed it and it is fresh at `now`: undefined otherwise.
 * Null for a genuine one Orqestra does not act on.
 */
export async function webhookEvent(
	source: WorkSource,
	rawBody: string,
	headers: Headers,
	now = Date.now(),
): Promise<SessionEvent | null | undefined> {
	const row = await db.query.integrationInstallation.findFirst({
		where: ofKind(source),
		columns: { webhookSecret: true },
	});
	const secret = row && decryptSecret(row.webhookSecret);
	if (!secret) return undefined;
	return source.event(rawBody, headers, secret, now);
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
		jobId: event.id,
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
 * Refreshes the app's tokens when due, checking every `every` ms, so a workspace with no session for 30 days keeps its installation;
 * a refusal marks it as needing a reinstall. One schedule however many workers run it, kept in the queue: the first check is when it is
 * first made, and a worker starting again keeps its cadence. Until the returned worker is closed.
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
