// A scripted GitHub, its REST API and OAuth endpoints reachable through `fetch`, for testing what installs and uses the app without it.
import {
	createHmac,
	createPublicKey,
	createVerify,
	generateKeyPairSync,
	randomUUID,
} from "node:crypto";

/**
 * A GitHub App installed on `account`: `credentials` are what its Admin enters, its private key a fresh PKCS#1 PEM as GitHub hands one
 * out. The app's JWT is checked as GitHub does (RS256 by that key, `iss` its id, at most 10 minutes long). `authorize` plays a person
 * approving a user authorization URL: the redirect's query, with a code the client's secret redeems once at the token endpoint, which
 * answers JSON only to `accept: application/json`, as GitHub does. `comments` holds each comment posted, `reactions` each reaction
 * added (its path under the repository), `revoked` each token revoked.
 */
export function fakeGitHub({
	account = "acme",
	user = { id: 4242, login: "octocat" },
	permissions = { octocat: "write" },
}: {
	account?: string;
	/** Who authorizes as themselves: GET /user answers with them for a token their authorization was given. */
	user?: { id: number; login: string };
	/** Each person's permission on every repository, as GitHub's collaborator permission names it; `read` for anyone else. */
	permissions?: Record<string, string>;
} = {}) {
	const { privateKey, publicKey } = generateKeyPairSync("rsa", {
		modulusLength: 2048,
		privateKeyEncoding: { type: "pkcs1", format: "pem" },
		publicKeyEncoding: { type: "spki", format: "pem" },
	});
	const credentials = {
		appId: "12345",
		privateKey,
		installationId: "678",
		webhookSecret: "hook-s3cret",
		clientId: "Iv1.client",
		clientSecret: "client-s3cret",
		slug: "orqestra-bot",
		label: "Orqestra",
	};
	const codes = new Set<string>();
	let n = 0;
	const json = (body: unknown, status = 200) => Response.json(body, { status });

	/** Whether `jwt` is the app's own, live at the fake's clock. */
	const appJwt = (jwt: string | undefined) => {
		const [header, payload, signature] = jwt?.split(".") ?? [];
		if (!signature) return false;
		const valid = createVerify("RSA-SHA256")
			.update(`${header}.${payload}`)
			.verify(createPublicKey(publicKey), signature, "base64url");
		const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
		const now = Date.now() / 1000;
		return (
			valid &&
			claims.iss === credentials.appId &&
			claims.iat <= now &&
			claims.exp > now &&
			claims.exp <= now + 600
		);
	};

	const gh = {
		credentials,
		account,
		installationTokens: new Set<string>(),
		userTokens: new Set<string>(),
		comments: [] as { repo: string; number: number; body: string }[],
		reactions: [] as { repo: string; at: string; content: string }[],
		revoked: [] as string[],
		/** Each token request's form and `accept` header. */
		tokenRequests: [] as { form: Record<string, string>; accept: string }[],
		authorize(url: string) {
			const q = new URL(url).searchParams;
			const code = `code-${codes.size + 1}`;
			if (q.get("client_id") === credentials.clientId) codes.add(code);
			return new URLSearchParams({ code, state: q.get("state") ?? "" });
		},
		async fetch(input: string | URL, init?: RequestInit): Promise<Response> {
			const url = new URL(String(input));
			const method = init?.method ?? "GET";
			const headers = new Headers(init?.headers);
			const bearer = headers.get("authorization")?.replace(/^Bearer /, "");
			const path = `${url.origin}${url.pathname}`;

			if (path === "https://github.com/login/oauth/access_token") {
				const form = Object.fromEntries(
					new URLSearchParams(init?.body as URLSearchParams),
				);
				const accept = headers.get("accept") ?? "";
				gh.tokenRequests.push({ form, accept });
				const answer: Record<string, string> =
					form.client_id === credentials.clientId &&
					form.client_secret === credentials.clientSecret &&
					codes.delete(form.code)
						? { access_token: `ghu_${++n}`, token_type: "bearer", scope: "" }
						: { error: "bad_verification_code" };
				if (answer.access_token) gh.userTokens.add(answer.access_token);
				// GitHub answers 200 either way, as a form unless asked for JSON
				return accept.includes("application/json")
					? json(answer)
					: new Response(new URLSearchParams(answer));
			}

			const installation = `https://api.github.com/app/installations/${credentials.installationId}`;
			if (path === `${installation}/access_tokens` && method === "POST") {
				if (!appJwt(bearer)) return json({ message: "Bad credentials" }, 401);
				const token = `ghs_${++n}`;
				gh.installationTokens.add(token);
				return json(
					{
						token,
						expires_at: new Date(Date.now() + 3_600_000).toISOString(),
					},
					201,
				);
			}
			if (path === installation) {
				if (!appJwt(bearer)) return json({ message: "Bad credentials" }, 401);
				return json({
					id: Number(credentials.installationId),
					account: { login: account, type: "Organization" },
				});
			}

			const comments =
				/^https:\/\/api\.github\.com\/repos\/([^/]+\/[^/]+)\/issues\/(\d+)\/comments$/.exec(
					path,
				);
			if (comments && method === "POST") {
				if (!bearer || !gh.installationTokens.has(bearer))
					return json({ message: "Bad credentials" }, 401);
				const { body } = JSON.parse(String(init?.body));
				if (body.length > 65_536)
					return json({ message: "Validation Failed" }, 422);
				gh.comments.push({
					repo: comments[1],
					number: Number(comments[2]),
					body,
				});
				return json({ id: gh.comments.length, body }, 201);
			}

			const installed = !!bearer && gh.installationTokens.has(bearer);
			const permission =
				/^https:\/\/api\.github\.com\/repos\/([^/]+\/[^/]+)\/collaborators\/([^/]+)\/permission$/.exec(
					path,
				);
			if (permission && method === "GET") {
				if (!installed) return json({ message: "Bad credentials" }, 401);
				return json({ permission: permissions[permission[2]] ?? "read" });
			}
			const reaction =
				/^https:\/\/api\.github\.com\/repos\/([^/]+\/[^/]+)\/((?:issues|pulls)\/comments\/\d+|issues\/\d+)\/reactions$/.exec(
					path,
				);
			if (reaction && method === "POST") {
				if (!installed) return json({ message: "Bad credentials" }, 401);
				const { content } = JSON.parse(String(init?.body));
				gh.reactions.push({ repo: reaction[1], at: reaction[2], content });
				return json({ id: gh.reactions.length, content }, 201);
			}

			if (path === "https://api.github.com/user") {
				if (!bearer || !gh.userTokens.has(bearer))
					return json({ message: "Bad credentials" }, 401);
				return json({ ...user, type: "User" });
			}

			if (
				path ===
					`https://api.github.com/applications/${credentials.clientId}/token` &&
				method === "DELETE"
			) {
				const basic = Buffer.from(
					`${credentials.clientId}:${credentials.clientSecret}`,
				).toString("base64");
				if (headers.get("authorization") !== `Basic ${basic}`)
					return json({ message: "Requires authentication" }, 401);
				const { access_token } = JSON.parse(String(init?.body));
				if (!gh.userTokens.delete(access_token))
					return json({ message: "Not Found" }, 404);
				gh.revoked.push(access_token);
				return new Response(null, { status: 204 });
			}

			return json({ message: "Not Found" }, 404);
		},
	};
	return gh;
}

type Sender = {
	id?: number;
	login?: string;
	type?: "User" | "Bot" | "Organization";
};

const sender = ({ id = 4242, login = "octocat", type = "User" }: Sender) => ({
	id,
	login,
	type,
});
const repository = {
	id: 1,
	name: "web",
	full_name: "acme/web",
	private: false,
};
const issue = (body: string | null, pullRequest = false) => ({
	id: 9001,
	number: 7,
	title: "Fix the login button",
	body,
	html_url: `https://github.com/acme/web/${pullRequest ? "pull" : "issues"}/7`,
	user: sender({}),
	...(pullRequest && { pull_request: { url: "" } }),
});

/** An `issue_comment` delivery's payload as GitHub sends it, with fewer fields: a comment on issue (or pull request) acme/web#7. */
export function issueComment({
	body,
	action = "created",
	from = {},
	pullRequest = false,
}: {
	body: string;
	action?: string;
	from?: Sender;
	pullRequest?: boolean;
}) {
	return {
		action,
		issue: issue("It does nothing on Safari.", pullRequest),
		comment: { id: 55, body, user: sender(from), html_url: "" },
		repository,
		sender: sender(from),
		installation: { id: 678 },
	};
}

/** An `issues` delivery's payload as GitHub sends it, with fewer fields: issue acme/web#7, given `label` when one is named. */
export function issueOpened({
	body,
	action = "opened",
	label,
	from = {},
}: {
	body: string | null;
	action?: string;
	label?: string;
	from?: Sender;
}) {
	return {
		action,
		issue: issue(body),
		...(label && { label: { id: 3, name: label } }),
		repository,
		sender: sender(from),
		installation: { id: 678 },
	};
}

/** A webhook delivery's raw body and headers, `X-Hub-Signature-256` the HMAC-SHA256 of the body with `secret`. */
export function delivery(
	event: string,
	payload: unknown,
	secret: string,
	id: string = randomUUID(),
) {
	const body = JSON.stringify(payload);
	return {
		body,
		headers: new Headers({
			"x-github-event": event,
			"x-github-delivery": id,
			"x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
			"content-type": "application/json",
		}),
	};
}

const pullRequest = {
	id: 9002,
	number: 7,
	title: "Fix the login button",
	body: "Closes #6.",
	html_url: "https://github.com/acme/web/pull/7",
	user: sender({}),
};

/** A `pull_request_review_comment` delivery's payload, with fewer fields: comment 56 on a line of pull request acme/web#7. */
export function reviewComment({
	body,
	action = "created",
	from = {},
}: {
	body: string;
	action?: string;
	from?: Sender;
}) {
	return {
		action,
		comment: { id: 56, body, path: "src/login.ts", user: sender(from) },
		pull_request: pullRequest,
		repository,
		sender: sender(from),
		installation: { id: 678 },
	};
}

/** A `pull_request_review` delivery's payload, with fewer fields: a review of pull request acme/web#7. */
export function review({
	body,
	action = "submitted",
	from = {},
}: {
	body: string | null;
	action?: string;
	from?: Sender;
}) {
	return {
		action,
		review: { id: 57, body, state: "commented", user: sender(from) },
		pull_request: pullRequest,
		repository,
		sender: sender(from),
		installation: { id: 678 },
	};
}
