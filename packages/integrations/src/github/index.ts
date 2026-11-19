// GitHub as an Integration: a GitHub App the Admin registers and installs on an account, mentioned as `@<slug>` in an issue or a pull
// request, which answers there in a comment. https://docs.github.com/en/apps, https://docs.github.com/en/webhooks
// Only how work is handed in and answered: the Agent's own git and GitHub tools are the GitHub MCP Server (ADR 0016).
import { createHmac, createSign, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { Credentials, Fetch, SessionEvent, WorkSource } from "../ports.ts";

const API = "https://api.github.com";

/** The most GitHub takes in a comment's body. */
const MAX_BODY = 65_536;
const TRUNCATED =
	"\n\n[Cut short: longer than GitHub shows. The whole of it is in the Conversation in Orqestra.]";

// only the fields Orqestra reads; the rest of the payload is ignored
const delivery = z.object({
	action: z.string(),
	issue: z.object({
		number: z.number(),
		title: z.string(),
		body: z.string().nullish(),
		html_url: z.string(),
	}),
	comment: z.object({ body: z.string() }).optional(),
	repository: z.object({ full_name: z.string() }),
	sender: z.object({ id: z.number(), login: z.string(), type: z.string() }),
});

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

/** `@<slug>` as a word of its own, not inside an email address or a longer handle. */
const mentionOf = (slug: string) =>
	`(?<![\\w-])@${slug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`;

export const github: WorkSource = {
	kind: "github",
	name: "GitHub",
	install: {
		mode: "credentials",
		// from the app's settings page, and the installation's id from its URL; `slug` is the handle people mention it by
		fields: [
			{ name: "appId", secret: false },
			{ name: "privateKey", secret: true },
			{ name: "installationId", secret: false },
			{ name: "webhookSecret", secret: true },
			{ name: "clientId", secret: false },
			{ name: "clientSecret", secret: true },
			{ name: "slug", secret: false },
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
		// shortcut: the slug comes in `credentials`, which the port's `event` does not pass yet; without it nothing is acted on.
		event(rawBody, headers, webhookSecret, _now, credentials?: Credentials) {
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
			const slug = credentials?.slug;
			const parsed = delivery.safeParse(payload);
			if (!id || !slug || !parsed.success) return null;
			const { action, issue, comment, repository, sender } = parsed.data;
			const kind = headers.get("x-github-event");
			const acted =
				kind === "issue_comment"
					? action === "created" && comment
					: kind === "issues" && action === "opened";
			// the app's own comments are a Bot's too: an answer never starts another session
			if (!acted || sender.type === "Bot") return null;
			const said = comment?.body ?? `${issue.title}\n${issue.body ?? ""}`;
			const at = mentionOf(slug);
			if (said.search(new RegExp(at, "i")) < 0) return null;
			const scope = repository.full_name;
			return {
				id,
				sessionId: `${scope}#${issue.number}`,
				// the core opens a session for a comment on an issue it has none for
				action: comment ? "prompted" : "created",
				from: { id: String(sender.id), name: sender.login },
				issue: {
					identifier: `${scope}#${issue.number}`,
					title: issue.title,
					description: issue.body ?? null,
					url: issue.html_url,
				},
				scope,
				shared: true,
				// an opened issue's own body is the prompt, already its description
				text: comment
					? comment.body.replace(new RegExp(`${at}[ \\t]*`, "gi"), "").trim()
					: null,
				stop: new RegExp(`${at}\\s+stop(?![\\w-])`, "i").test(said),
			} satisfies SessionEvent;
		},
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
		// GitHub has no status to show work under way, and a comment per thought buries the thread. shortcut: an `eyes` reaction on the
		// issue (POST /repos/{repo}/issues/{n}/reactions) is the cheap signal; add it if people ask whether it heard them.
		if (type === "thought") return;
		const [, repo, number] = /^(.+)#(\d+)$/.exec(sessionId) ?? [];
		if (!repo) throw new Error(`Not a GitHub session: ${sessionId}`);
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
