// Linear as an Integration: its app installs into a Linear workspace as itself (OAuth with actor=app), its webhook tells it of Agent
// Sessions, and it answers with agent activities. https://linear.app/developers/agents, https://linear.app/developers/webhooks
// Linear's access tokens last 24 hours; each refresh rotates the refresh token, which lapses 30 days after it was issued, used or not.
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { Activity, Fetch, SessionEvent, WorkSource } from "../ports.ts";

/** How far a webhook's signed `webhookTimestamp` may be from now: Linear's own SDK refuses one over a minute off. */
const FRESH_MS = 60_000;

/** The most Linear takes in an activity's body. */
const MAX_BODY = 250_000;
const TRUNCATED =
	"\n\n[Cut short: longer than Linear shows. The whole of it is in the Conversation in Orqestra.]";

const person = z.object({ id: z.string(), name: z.string() });
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

/** One GraphQL request to Linear with an access token: its `data`; throws on an HTTP or GraphQL error. */
export async function linearGraphql(
	accessToken: string,
	query: string,
	{
		variables,
		fetch = globalThis.fetch,
	}: { variables?: Record<string, unknown>; fetch?: Fetch } = {},
): Promise<unknown> {
	const response = await fetch("https://api.linear.app/graphql", {
		method: "POST",
		headers: {
			authorization: `Bearer ${accessToken}`,
			"content-type": "application/json",
		},
		body: JSON.stringify({ query, variables }),
		signal: AbortSignal.timeout(30_000),
	});
	const body = (await response.json().catch(() => ({}))) as {
		data?: unknown;
		errors?: { message: string }[];
	};
	if (!response.ok || body.errors?.length || body.data == null)
		throw new Error(
			`Linear's GraphQL API answered ${response.status}: ${body.errors?.map((e) => e.message).join("; ") ?? ""}`,
		);
	return body.data;
}

export const linear: WorkSource = {
	kind: "linear",
	name: "Linear",
	authorize: {
		url: "https://linear.app/oauth/authorize",
		// to read and write, and to be assigned issues and mentioned as an agent
		scope: "read,write,app:assignable,app:mentionable",
		params: { actor: "app" },
	},
	tokenUrl: "https://api.linear.app/oauth/token",

	async workspace(accessToken, fetch) {
		const { organization } = z
			.object({ organization: z.object({ name: z.string() }) })
			.parse(
				await linearGraphql(accessToken, "{ organization { name } }", {
					fetch,
				}),
			);
		return organization.name;
	},

	// a person's own authorization (actor=user, the default) is only to learn who they are
	accountScope: "read",

	async account(accessToken, fetch) {
		const { viewer } = z
			.object({ viewer: z.object({ id: z.string(), name: z.string() }) })
			.parse(
				await linearGraphql(accessToken, "{ viewer { id name } }", { fetch }),
			);
		return viewer;
	},

	async revoke(accessToken, fetch) {
		const response = await fetch("https://api.linear.app/oauth/revoke", {
			method: "POST",
			headers: { authorization: `Bearer ${accessToken}` },
			signal: AbortSignal.timeout(30_000),
		});
		if (!response.ok)
			throw new Error(`Linear's revoke endpoint answered ${response.status}`);
	},

	// `Linear-Signature` is the hex HMAC-SHA256 of the raw body with the webhook secret
	event(rawBody, headers, webhookSecret, now) {
		const signature = headers.get("linear-signature");
		if (!signature) return undefined;
		const expected = Buffer.from(
			createHmac("sha256", webhookSecret).update(rawBody).digest("hex"),
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
			sessionId: session.id,
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
	},

	async post(accessToken, agentSessionId, { type, body }: Activity, fetch) {
		const content = {
			type,
			body:
				body.length <= MAX_BODY
					? body
					: // leaving no half of a surrogate pair at the cut
						body
							.slice(0, MAX_BODY - TRUNCATED.length)
							.replace(/[\uD800-\uDBFF]$/, "") + TRUNCATED,
		};
		await linearGraphql(
			accessToken,
			"mutation ($input: AgentActivityCreateInput!) { agentActivityCreate(input: $input) { success } }",
			{ variables: { input: { agentSessionId, content } }, fetch },
		);
	},

	// its issue, the repository its team works in, and what it was started with
	firstMessage: (event: SessionEvent, repo) =>
		[
			event.issue &&
				`Linear issue ${event.issue.identifier}: ${event.issue.title}\n${event.issue.url}`,
			repo && `Repository: ${repo}`,
			event.issue?.description,
			event.text,
		]
			.filter(Boolean)
			.join("\n\n") ||
		"A Linear Agent Session started with no issue or comment.",
};
