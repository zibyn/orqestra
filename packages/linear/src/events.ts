// What Linear's webhook tells Orqestra's app about its Agent Sessions, queued for the worker, and the activities it answers with; and the
// worker's schedule that keeps the app's tokens from lapsing.
// https://linear.app/developers/webhooks, https://linear.app/developers/agent-interaction
import { createHmac, timingSafeEqual } from "node:crypto";
import { db } from "@orqestra/db";
import { decryptSecret } from "@orqestra/db/secret";
import { createPostgresBackend, Queue, Worker } from "bullmq";
import { z } from "zod";
import { type Fetch, linearAccessToken, linearGraphql } from "./index.ts";

const LINEAR_TOKENS_QUEUE = "linear-tokens";

/**
 * How often the worker checks the app's tokens. An access token lasts 24 hours and comes with its refresh token, so a daily check
 * refreshes each refresh token within 2 days of its issue, far inside the 30 days after which it lapses however much it was used.
 */
const TOKEN_CHECK_EVERY_MS = 24 * 3_600_000;

/** How far a webhook's signed `webhookTimestamp` may be from now: Linear's own SDK refuses one over a minute off. */
const FRESH_MS = 60_000;

const LINEAR_EVENTS_QUEUE = "linear-events";

/** A Linear Agent Session started (`created`: the app was delegated an issue or mentioned) or prompted again, as the worker acts on it. */
export type LinearEvent = {
	/** One per session start or prompt: a redelivery is the same job. */
	id: string;
	agentSessionId: string;
	action: "created" | "prompted";
	/** Who started the session, or wrote the prompt; null for a session no person started. */
	from: { email: string; name: string } | null;
	issue: {
		identifier: string;
		title: string;
		description: string | null;
		url: string;
		teamKey: string;
	} | null;
	/** The comment that mentioned the app, or the prompt. */
	text: string | null;
	/** The prompt asks the agent to stop. */
	stop: boolean;
};

const person = z.object({ email: z.string(), name: z.string() });
// only the fields Orqestra reads; the rest of the payload is ignored
const agentSessionEvent = z.object({
	type: z.literal("AgentSessionEvent"),
	action: z.enum(["created", "prompted"]),
	agentSession: z.object({
		id: z.string(),
		creator: person.nullish(),
		comment: z.object({ body: z.string() }).nullish(),
		issue: z
			.object({
				identifier: z.string(),
				title: z.string(),
				description: z.string().nullish(),
				url: z.string(),
				team: z.object({ key: z.string() }),
			})
			.nullish(),
	}),
	// a prompted event's; the prompt is its content's `body`
	agentActivity: z
		.object({
			id: z.string(),
			signal: z.string().nullish(),
			content: z.object({ body: z.string().optional() }),
			user: person,
		})
		.nullish(),
});

/**
 * A webhook request's event, when the installation's webhook secret signed its raw body and its signed timestamp is within a minute
 * of `now`: undefined otherwise. Null for a genuine one Orqestra does not act on.
 */
export async function linearWebhookEvent(
	rawBody: string,
	signature: string | null,
	now = Date.now(),
): Promise<LinearEvent | null | undefined> {
	const row = await db.query.linearInstallation.findFirst({
		columns: { webhookSecret: true },
	});
	const secret = row && decryptSecret(row.webhookSecret);
	if (!secret || !signature) return undefined;
	const expected = Buffer.from(
		createHmac("sha256", secret).update(rawBody).digest("hex"),
	);
	const given = Buffer.from(signature);
	if (expected.length !== given.length || !timingSafeEqual(expected, given))
		return undefined;
	let payload: unknown;
	try {
		payload = JSON.parse(rawBody);
	} catch {
		return undefined;
	}
	const sent = (payload as { webhookTimestamp?: unknown }).webhookTimestamp;
	if (typeof sent !== "number" || Math.abs(now - sent) > FRESH_MS)
		return undefined;
	const parsed = agentSessionEvent.safeParse(payload);
	if (!parsed.success) return null;
	const {
		action,
		agentSession: session,
		agentActivity: activity,
	} = parsed.data;
	if (action === "prompted" && !activity) return null;
	const issue = session.issue;
	return {
		id: activity ? `prompted-${activity.id}` : `created-${session.id}`,
		agentSessionId: session.id,
		action,
		from: (action === "prompted" ? activity?.user : session.creator) ?? null,
		issue: issue
			? {
					identifier: issue.identifier,
					title: issue.title,
					description: issue.description ?? null,
					url: issue.url,
					teamKey: issue.team.key,
				}
			: null,
		text:
			(action === "prompted"
				? activity?.content.body
				: session.comment?.body) ?? null,
		stop: activity?.signal === "stop",
	};
}

const connection = () => ({
	connectionString: process.env.DATABASE_URL as string,
	// the api may queue an event before any worker has set up BullMQ's schema
	migrate: true,
});

const newQueue = () =>
	new Queue(
		LINEAR_EVENTS_QUEUE,
		{ connection: connection() },
		createPostgresBackend,
	);
let queue: ReturnType<typeof newQueue> | undefined;
/** Queues an event for the worker; one already queued in the last day, or that failed, is not queued again. */
export async function queueLinearEvent(event: LinearEvent) {
	queue ??= newQueue();
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
export async function serveLinearEvents(
	handle: (event: LinearEvent) => Promise<void>,
) {
	const worker = new Worker(
		LINEAR_EVENTS_QUEUE,
		(job) => handle(job.data),
		{ connection: connection() },
		createPostgresBackend,
	);
	worker.on("failed", (job, err) =>
		console.error(`Linear event ${job?.id} failed`, err),
	);
	worker.on("error", (err) => console.error("worker error", err));
	await worker.waitUntilReady();
	return worker;
}

/**
 * Refreshes the app's tokens when due, now and `every` ms after, so a workspace with no Agent Session for 30 days keeps its installation;
 * a refusal marks it as needing a reinstall. One schedule however many workers run it, until the returned worker is closed.
 */
export async function serveLinearTokenRefresh({
	every = TOKEN_CHECK_EVERY_MS,
	fetch,
}: {
	every?: number;
	fetch?: Fetch;
} = {}) {
	const queue = new Queue(
		LINEAR_TOKENS_QUEUE,
		{ connection: connection() },
		createPostgresBackend,
	);
	await queue.upsertJobScheduler(
		LINEAR_TOKENS_QUEUE,
		{ every },
		{ name: "refresh", opts: { removeOnComplete: true, removeOnFail: 100 } },
	);
	await queue.close();
	const worker = new Worker(
		LINEAR_TOKENS_QUEUE,
		// returns nothing: BullMQ would store a returned token
		async () => {
			await linearAccessToken({ fetch });
		},
		{ connection: connection() },
		createPostgresBackend,
	);
	worker.on("failed", (_job, err) =>
		console.error("Refreshing the Linear app's tokens failed", err),
	);
	worker.on("error", (err) => console.error("worker error", err));
	await worker.waitUntilReady();
	return worker;
}

/**
 * Posts an activity into an Agent Session as the app, its body Markdown: a thought, which Linear shows as the agent at work; a response,
 * which completes the turn; an elicitation, which waits for the person's answer; or an error.
 */
export async function postAgentActivity(
	agentSessionId: string,
	content: {
		type: "thought" | "response" | "elicitation" | "error";
		body: string;
	},
	{ fetch }: { fetch?: Fetch } = {},
) {
	const token = await linearAccessToken({ fetch });
	if (!token) throw new Error("The Linear app is not installed");
	await linearGraphql(
		token,
		"mutation ($input: AgentActivityCreateInput!) { agentActivityCreate(input: $input) { success } }",
		{ variables: { input: { agentSessionId, content } }, fetch },
	);
}
