import { describe, expect, it } from "vitest";
import type {
	Credentials,
	CredentialsInstall,
	Fetch,
	OAuthProof,
	SessionEvent,
	WebhookIngress,
} from "../ports.ts";
import { github } from "./index.ts";
import { delivery, fakeGitHub, issueComment, issueOpened } from "./testing.ts";

const install = github.install as CredentialsInstall;
const proof = github.proof as OAuthProof;
const installToken = (credentials: Credentials, fetch: Fetch) => {
	if (!install.token) throw new Error("GitHub's install trades for a token");
	return install.token(credentials, fetch);
};
// shortcut: the port's `event` does not pass the installation's credentials yet, which hold the slug; drop the cast once it does
const event = (github.ingress as WebhookIngress).event as (
	...args: [...Parameters<WebhookIngress["event"]>, Credentials?]
) => SessionEvent | null | undefined;

/** A delivery's event as the adapter reads it, signed with the fake's webhook secret unless `secret` says otherwise. */
function receive(
	gh: ReturnType<typeof fakeGitHub>,
	kind: string,
	payload: unknown,
	{ secret = gh.credentials.webhookSecret, id = "delivery-1" } = {},
) {
	const { body, headers } = delivery(kind, payload, secret, id);
	return event(
		body,
		headers,
		gh.credentials.webhookSecret,
		Date.now(),
		gh.credentials,
	);
}

describe("github install", () => {
	it("trades the app's key for an hour's installation token, and names the account it is installed on", async () => {
		const gh = fakeGitHub({ account: "acme" });
		const { accessToken, expiresAt } = await installToken(
			gh.credentials,
			gh.fetch,
		);
		expect(gh.installationTokens.has(accessToken)).toBe(true);
		expect(expiresAt - Date.now()).toBeGreaterThan(3_590_000);
		expect(
			await install.workspace(
				{ token: accessToken, credentials: gh.credentials },
				gh.fetch,
			),
		).toBe("acme");
	});

	it("is refused a key that is not the app's", async () => {
		const gh = fakeGitHub();
		const other = fakeGitHub().credentials.privateKey;
		const credentials = { ...gh.credentials, privateKey: other };
		await expect(installToken(credentials, gh.fetch)).rejects.toThrow(/401/);
		await expect(
			install.workspace({ token: "", credentials }, gh.fetch),
		).rejects.toThrow(/401/);
	});
});

describe("github webhook", () => {
	it("starts a session from a comment that mentions the app, the mention cut from its text", () => {
		const gh = fakeGitHub();
		expect(
			receive(
				gh,
				"issue_comment",
				issueComment({ body: "Hey @orqestra-bot please fix this." }),
				{ id: "d-1" },
			),
		).toEqual({
			id: "d-1",
			sessionId: "acme/web#7",
			action: "prompted",
			from: { id: "4242", name: "octocat" },
			issue: {
				identifier: "acme/web#7",
				title: "Fix the login button",
				description: "It does nothing on Safari.",
				url: "https://github.com/acme/web/issues/7",
			},
			scope: "acme/web",
			shared: true,
			text: "Hey please fix this.",
			stop: false,
		});
	});

	it("takes a pull request's comment the same way", () => {
		const gh = fakeGitHub();
		const e = receive(
			gh,
			"issue_comment",
			issueComment({ body: "@Orqestra-Bot review", pullRequest: true }),
		);
		expect(e?.sessionId).toBe("acme/web#7");
		expect(e?.issue?.url).toBe("https://github.com/acme/web/pull/7");
		expect(e?.text).toBe("review");
	});

	it("starts one from an issue opened with a mention", () => {
		const gh = fakeGitHub();
		const e = receive(
			gh,
			"issues",
			issueOpened({ body: "@orqestra-bot it breaks on Safari" }),
		);
		expect(e).toMatchObject({
			action: "created",
			sessionId: "acme/web#7",
			text: null,
			issue: { description: "@orqestra-bot it breaks on Safari" },
		});
	});

	it("stops on a mention followed by stop", () => {
		const gh = fakeGitHub();
		const stop = (body: string) =>
			receive(gh, "issue_comment", issueComment({ body }))?.stop;
		expect(stop("@orqestra-bot stop")).toBe(true);
		expect(stop("@orqestra-bot  Stop, wrong branch")).toBe(true);
		expect(stop("@orqestra-bot stopwatch is broken")).toBe(false);
		expect(stop("@orqestra-bot please fix; stop the X")).toBe(false);
	});

	it("ignores text that does not mention the app as a word", () => {
		const gh = fakeGitHub();
		for (const body of [
			"no mention here",
			"mail me@orqestra-bot.dev",
			"@orqestra-bot-two do it",
			"@orqestra-botty",
		])
			expect(receive(gh, "issue_comment", issueComment({ body }))).toBeNull();
	});

	it("ignores any bot, the app's own answers included", () => {
		const gh = fakeGitHub();
		expect(
			receive(
				gh,
				"issue_comment",
				issueComment({
					body: "Done, @orqestra-bot answered: …",
					from: { id: 99, login: "orqestra-bot[bot]", type: "Bot" },
				}),
			),
		).toBeNull();
		expect(
			receive(
				gh,
				"issues",
				issueOpened({
					body: "@orqestra-bot",
					from: { login: "dependabot[bot]", type: "Bot" },
				}),
			),
		).toBeNull();
	});

	it("ignores other events and actions", () => {
		const gh = fakeGitHub();
		const body = "@orqestra-bot fix";
		expect(
			receive(gh, "issue_comment", issueComment({ body, action: "edited" })),
		).toBeNull();
		expect(
			receive(gh, "issues", issueOpened({ body, action: "edited" })),
		).toBeNull();
		expect(receive(gh, "push", issueComment({ body }))).toBeNull();
		expect(
			receive(gh, "ping", { zen: "Keep it logically awesome." }),
		).toBeNull();
	});

	it("refuses a delivery the webhook secret did not sign", () => {
		const gh = fakeGitHub();
		const payload = issueComment({ body: "@orqestra-bot fix" });
		expect(
			receive(gh, "issue_comment", payload, { secret: "someone-else" }),
		).toBeUndefined();
		const { body, headers } = delivery(
			"issue_comment",
			payload,
			gh.credentials.webhookSecret,
		);
		// a body changed after signing
		expect(
			event(
				body.replace("fix", "rm -rf"),
				headers,
				gh.credentials.webhookSecret,
				Date.now(),
				gh.credentials,
			),
		).toBeUndefined();
		headers.delete("x-hub-signature-256");
		expect(
			event(
				body,
				headers,
				gh.credentials.webhookSecret,
				Date.now(),
				gh.credentials,
			),
		).toBeUndefined();
	});
});

describe("github post", () => {
	it("answers in a comment on the issue, and shows no thought", async () => {
		const gh = fakeGitHub();
		const { accessToken: token } = await installToken(gh.credentials, gh.fetch);
		const auth = { token, credentials: gh.credentials };
		await github.post(
			auth,
			"acme/web#7",
			{ type: "thought", body: "Working on this in Orqestra." },
			gh.fetch,
		);
		await github.post(
			auth,
			"acme/web#7",
			{ type: "response", body: "Fixed in #8." },
			gh.fetch,
		);
		expect(gh.comments).toEqual([
			{ repo: "acme/web", number: 7, body: "Fixed in #8." },
		]);
	});

	it("cuts a body longer than GitHub takes, saying the rest is in Orqestra", async () => {
		const gh = fakeGitHub();
		const { accessToken: token } = await installToken(gh.credentials, gh.fetch);
		await github.post(
			{ token, credentials: gh.credentials },
			"acme/web#7",
			{ type: "response", body: "x".repeat(70_000) },
			gh.fetch,
		);
		const [{ body }] = gh.comments;
		expect(body.length).toBeLessThanOrEqual(65_536);
		expect(body).toMatch(/whole of it is in the Conversation in Orqestra/);
	});

	it("throws when GitHub refuses the token", async () => {
		const gh = fakeGitHub();
		await expect(
			github.post(
				{ token: "ghs_stale", credentials: gh.credentials },
				"acme/web#7",
				{ type: "response", body: "hi" },
				gh.fetch,
			),
		).rejects.toThrow(/401/);
	});
});

describe("github proof", () => {
	it("learns who authorized by the id webhooks name them with, then revokes their token", async () => {
		const gh = fakeGitHub({ user: { id: 4242, login: "octocat" } });
		const { code } = Object.fromEntries(
			gh.authorize(
				`${proof.authorizeUrl}?client_id=${gh.credentials.clientId}&state=s`,
			),
		);
		const response = await gh.fetch(proof.tokenUrl, {
			method: "POST",
			headers: { accept: "application/json" },
			body: new URLSearchParams({
				client_id: gh.credentials.clientId,
				client_secret: gh.credentials.clientSecret,
				code: code ?? "",
			}),
		});
		const { access_token } = (await response.json()) as {
			access_token: string;
		};
		const from = receive(
			gh,
			"issue_comment",
			issueComment({ body: "@orqestra-bot hi" }),
		)?.from;
		expect(await proof.account(access_token, gh.fetch)).toEqual(from);

		const client = {
			id: gh.credentials.clientId,
			secret: gh.credentials.clientSecret,
		};
		await proof.revoke(access_token, client, gh.fetch);
		expect(gh.revoked).toEqual([access_token]);
		await expect(proof.account(access_token, gh.fetch)).rejects.toThrow(/401/);
		await expect(
			proof.revoke(access_token, { ...client, secret: "wrong" }, gh.fetch),
		).rejects.toThrow(/401/);
	});
});

describe("github firstMessage", () => {
	it("gives the issue, its repository, its body and the comment that asked", () => {
		const gh = fakeGitHub();
		const e = receive(
			gh,
			"issue_comment",
			issueComment({ body: "@orqestra-bot fix it" }),
		);
		if (!e) throw new Error("no event");
		expect(github.firstMessage(e, "acme/web-mono")).toBe(
			[
				"GitHub acme/web#7: Fix the login button\nhttps://github.com/acme/web/issues/7",
				"Repository: acme/web-mono",
				"It does nothing on Safari.",
				"fix it",
			].join("\n\n"),
		);
		expect(github.firstMessage(e, undefined)).toContain("Repository: acme/web");
	});
});
