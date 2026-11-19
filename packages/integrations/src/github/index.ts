// GitHub as an Integration: a GitHub App the Admin registers and installs on an account, mentioned as `@<slug>` in an issue or a pull
// request, which answers there in a comment. https://docs.github.com/en/apps, https://docs.github.com/en/webhooks
// Only how work is handed in and answered: the Agent's own git and GitHub tools are the GitHub MCP Server (ADR 0016).
// The App's repository permissions: Issues and Pull requests read and write (comments, reactions), Metadata read (who may write), and
// Contents read, or write when the Agent's GitHub MCP Connection, a user token of this app, pushes branches. Its webhook events: Issues,
// Issue comment (a pull request's too), Pull request review, and Pull request review comment.
// Handed in as claude-code-action and OpenHands take it: a new comment, review or issue that mentions the app, or an issue given the
// installation's `label`. Not by assigning an issue, which GitHub allows only to people, not to an ordinary App.
// shortcut: GitHub does not redeliver a delivery Orqestra failed to take; a scheduled job could list the app's failed ones
// (GET /app/hook/deliveries) and redeliver them (POST /app/hook/deliveries/{id}/attempts). Build it once deliveries are seen lost.
import { createHmac, createSign, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { Credentials, Fetch, SessionEvent, WorkSource } from "../ports.ts";

const API = "https://api.github.com";

/** The most GitHub takes in a comment's body. */
const MAX_BODY = 65_536;
const TRUNCATED =
	"\n\n[Cut short: longer than GitHub shows. The whole of it is in the Conversation in Orqestra.]";

// an issue or a pull request, as either event names it
const thread = z.object({
	number: z.number(),
	title: z.string(),
	body: z.string().nullish(),
	html_url: z.string(),
});
// only the fields Orqestra reads; the rest of the payload is ignored
const delivery = z.object({
	action: z.string(),
	issue: thread.optional(),
	pull_request: thread.optional(),
	comment: z.object({ id: z.number(), body: z.string() }).optional(),
	review: z.object({ body: z.string().nullish() }).optional(),
	label: z.object({ name: z.string() }).optional(),
	installation: z.object({ id: z.number() }),
	repository: z.object({ full_name: z.string() }),
	sender: z.object({ id: z.number(), login: z.string(), type: z.string() }),
});

/**
 * What a person wrote, cleared of what GitHub does not show them but the Agent would read: HTML comments, invisible and control
 * characters, image alt text and hidden HTML attributes (claude-code-action's sanitizer.ts).
 */
const sanitize = (text: string) =>
	text
		.replace(/<!--[\s\S]*?-->/g, "")
		.replace(
			// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this strips
			/[\u200B-\u200D\uFEFF\u00AD\u202A-\u202E\u2066-\u2069\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g,
			"",
		)
		.replace(/!\[[^\]]*\](?=[([])/g, "![]")
		.replace(
			/\s(?:alt|title|aria-label|placeholder|data-[\w-]+)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi,
			"",
		);

/** One request to GitHub's REST API: its JSON, null when it has no body; throws on an HTTP error. */
async function rest(
	fetch: Fetch,
	authorization: string,
	path: string,
	{ method = "GET", body }: { method?: string; body?: unknown } = {},
): Promise<unknown> {
	const response = await fetch(`${API}${path}`, {
		method,
		headers: {
			authorization,
			accept: "application/vnd.github+json",
			"x-github-api-version": "2022-11-28",
			...(body !== undefined && { "content-type": "application/json" }),
		},
		body: body === undefined ? undefined : JSON.stringify(body),
		signal: AbortSignal.timeout(30_000),
	});
	if (!response.ok)
		throw new Error(`GitHub's ${method} ${path} answered ${response.status}`);
	return response.status === 204 ? null : response.json();
}

/** The app's own JWT (RS256), which GitHub takes for 10 minutes at most: issued a minute back and ended a minute early, for clock drift. */
function appJwt({ appId, privateKey }: Credentials, now = Date.now()) {
	const s = Math.floor(now / 1000);
	const part = (o: object) =>
		Buffer.from(JSON.stringify(o)).toString("base64url");
	const unsigned = `${part({ alg: "RS256", typ: "JWT" })}.${part({ iat: s - 60, exp: s + 540, iss: appId })}`;
	return `${unsigned}.${createSign("RSA-SHA256").update(unsigned).sign(privateKey, "base64url")}`;
}

const installation = ({ installationId }: Credentials) =>
	`/app/installations/${encodeURIComponent(installationId)}`;

/** `@<slug>` after a space or the start and before one or punctuation, as claude-code-action matches its trigger phrase. */
const mentionOf = (slug: string) =>
	`(^|\\s)@${slug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=[\\s.,!?;:]|$)`;

/** The repository and the issue or pull request number a session's id names. */
const sessionOf = (id: string) => {
	const [, repo, number] = /^(.+)#(\d+)$/.exec(id) ?? [];
	if (!repo) throw new Error(`Not a GitHub session: ${id}`);
	return { repo, number };
};

export const github: WorkSource = {
	kind: "github",
	name: "GitHub",
	install: {
		mode: "credentials",
		// from the app's settings page, and the installation's id from its URL; `slug` is the handle people mention it by, `label` the
		// one that hands an issue in when given to it
		fields: [
			{ name: "appId", secret: false },
			{ name: "privateKey", secret: true },
			{ name: "installationId", secret: false },
			{ name: "webhookSecret", secret: true },
			{ name: "clientId", secret: false },
			{ name: "clientSecret", secret: true },
			{ name: "slug", secret: false },
			{ name: "label", secret: false, optional: true },
		],

		// an installation access token lasts an hour
		async token(credentials, fetch) {
			const { token, expires_at } = z
				.object({ token: z.string(), expires_at: z.string() })
				.parse(
					await rest(
						fetch,
						`Bearer ${appJwt(credentials)}`,
						`${installation(credentials)}/access_tokens`,
						{ method: "POST" },
					),
				);
			return { accessToken: token, expiresAt: Date.parse(expires_at) };
		},

		// the account it is installed on, which only the app's own key and the installation's id together reach
		async workspace({ credentials }, fetch) {
			const { account } = z
				.object({ account: z.object({ login: z.string() }) })
				.parse(
					await rest(
						fetch,
						`Bearer ${appJwt(credentials)}`,
						installation(credentials),
					),
				);
			return account.login;
		},
	},

	ingress: {
		mode: "webhook",
		// `X-Hub-Signature-256` is `sha256=` and the hex HMAC-SHA256 of the raw body with the webhook secret.
		// shortcut: GitHub signs no timestamp, so a captured delivery replays at will; the job id (`X-GitHub-Delivery`, kept by a
		// redelivery) drops a redelivery, not a replay. Keep the webhook secret per deployment; nothing better exists until GitHub signs a time.
		event(rawBody, headers, webhookSecret, _now, credentials) {
			const signature = headers.get("x-hub-signature-256");
			if (!signature) return undefined;
			const expected = Buffer.from(
				`sha256=${createHmac("sha256", webhookSecret).update(rawBody).digest("hex")}`,
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
			const id = headers.get("x-github-delivery");
			const { slug, label: trigger, installationId } = credentials;
			const parsed = delivery.safeParse(payload);
			if (!id || !slug || !parsed.success) return null;
			const { action, issue, pull_request, comment, review, label } =
				parsed.data;
			const { installation, repository, sender } = parsed.data;
			// one App sends every installation's deliveries to the one webhook URL
			if (String(installation.id) !== installationId) return null;
			// people only: the app's own answers, or any bot's, never start another session
			if (
				sender.type !== "User" ||
				sender.login.toLowerCase() === `${slug}[bot]`.toLowerCase()
			)
				return null;
			const thread = issue ?? pull_request;
			const on = `${headers.get("x-github-event")}.${action}`;
			// what was newly written that may mention the app; never an edit, which would hand the same work in again
			const written =
				on === "issue_comment.created" ||
				on === "pull_request_review_comment.created"
					? comment?.body
					: on === "pull_request_review.submitted"
						? (review?.body ?? "")
						: on === "issues.opened" && thread
							? `${thread.title}\n${thread.body ?? ""}`
							: undefined;
			const labeled =
				on === "issues.labeled" &&
				!!trigger &&
				label?.name.toLowerCase() === trigger.toLowerCase();
			if (!thread || (written === undefined && !labeled)) return null;
			const said = sanitize(written ?? "");
			const at = mentionOf(slug);
			if (!labeled && !new RegExp(at, "i").test(said)) return null;
			const scope = repository.full_name;
			const asked = comment ?? review;
			return {
				// the core uses the id only as the job id, so it carries the path `accept` reacts at, after the delivery's own id
				id: `${id}/${comment ? `${issue ? "issues" : "pulls"}/comments/${comment.id}` : `issues/${thread.number}`}`,
				sessionId: `${scope}#${thread.number}`,
				// the core opens a session for a comment on an issue it has none for
				action: asked ? "prompted" : "created",
				from: { id: String(sender.id), name: sender.login },
				issue: {
					identifier: `${scope}#${thread.number}`,
					title: sanitize(thread.title),
					description: thread.body ? sanitize(thread.body) : null,
					url: thread.html_url,
				},
				scope,
				shared: true,
				// an opened or labeled issue's own body is the prompt, already its description
				text: asked
					? said.replace(new RegExp(`${at}[ \\t]*`, "gi"), "$1").trim()
					: null,
				stop: new RegExp(`${at}\\s+stop(?![\\w-])`, "i").test(said),
			} satisfies SessionEvent;
		},
	},

	// Only someone who may write to the repository hands the app work, as claude-code-action and OpenHands check. GitHub's
	// `permission` folds maintain into write and triage into read. No fallback to organization membership, which grants no write.
	async accept({ token }, { id, sessionId, from }, fetch) {
		const { repo } = sessionOf(sessionId);
		if (!from) return "No GitHub user handed this in.";
		const { permission } = z
			.object({ permission: z.string() })
			.parse(
				await rest(
					fetch,
					`Bearer ${token}`,
					`/repos/${repo}/collaborators/${encodeURIComponent(from.name)}/permission`,
				),
			);
		if (permission !== "admin" && permission !== "write")
			return `${from.name} needs write access to ${repo} to hand work to the app.`;
		// 👀 on the comment, else on the issue or pull request: a review takes no reaction
		await rest(
			fetch,
			`Bearer ${token}`,
			`/repos/${repo}/${id.slice(id.indexOf("/") + 1)}/reactions`,
			{ method: "POST", body: { content: "eyes" } },
		);
		return undefined;
	},

	proof: {
		mode: "oauth",
		authorizeUrl: "https://github.com/login/oauth/authorize",
		tokenUrl: "https://github.com/login/oauth/access_token",
		// a GitHub App's user authorization takes no scope: its token reaches what the app's permissions and the person's own allow
		scope: "",

		async account(accessToken, fetch) {
			const { id, login } = z
				.object({ id: z.number(), login: z.string() })
				.parse(await rest(fetch, `Bearer ${accessToken}`, "/user"));
			// the id a webhook's `sender` names them by
			return { id: String(id), name: login };
		},

		// ends this token only: the person's other tokens of the app, such as their GitHub MCP Connection's, stay
		async revoke(accessToken, client, fetch) {
			await rest(
				fetch,
				`Basic ${Buffer.from(`${client.id}:${client.secret}`).toString("base64")}`,
				`/applications/${encodeURIComponent(client.id)}/token`,
				{ method: "DELETE", body: { access_token: accessToken } },
			);
		},
	},

	// a public repository's comments are world-readable, so the Admin opens each repository the app answers in
	sharedScopes: "listed",

	async post({ token }, sessionId, { type, body }, fetch) {
		// GitHub has no status to show work under way, and a comment per thought buries the thread: `accept`'s 👀 says it heard
		if (type === "thought") return;
		const { repo, number } = sessionOf(sessionId);
		await rest(
			fetch,
			`Bearer ${token}`,
			`/repos/${repo}/issues/${number}/comments`,
			{
				method: "POST",
				body: {
					body:
						body.length <= MAX_BODY
							? body
							: // leaving no half of a surrogate pair at the cut
								body
									.slice(0, MAX_BODY - TRUNCATED.length)
									.replace(/[\uD800-\uDBFF]$/, "") + TRUNCATED,
				},
			},
		);
	},

	// its issue or pull request, the repository it works in, and the comment that asked
	firstMessage: (event, repo) =>
		[
			event.issue &&
				`GitHub ${event.issue.identifier}: ${event.issue.title}\n${event.issue.url}`,
			`Repository: ${repo ?? event.scope}`,
			event.issue?.description,
			event.text,
		]
			.filter(Boolean)
			.join("\n\n"),
};
