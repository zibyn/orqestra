// A scripted Linear, its token endpoint and GraphQL API reachable through `fetch`, for testing what installs and uses the app without it.
import { createHmac, randomUUID } from "node:crypto";

/**
 * `authorize` plays a workspace admin approving an authorization URL: the redirect's query, with a code that `clientSecret` and the
 * same redirect_uri redeem once. Refresh tokens rotate, each used once. `tokenRequests` holds each token request's form;
 * `accessTokens` and `refreshTokens` the live ones; `activities` the input of each agentActivityCreate.
 */
export function fakeLinear({
	workspace = "Acme",
	clientSecret = "client-s3cret",
}: {
	workspace?: string;
	clientSecret?: string;
} = {}) {
	const codes = new Map<string, { clientId: string; redirectUri: string }>();
	let n = 0;
	const issue = () => {
		n++;
		linear.accessTokens.add(`access-${n}`);
		linear.refreshTokens.add(`refresh-${n}`);
		return Response.json({
			access_token: `access-${n}`,
			token_type: "Bearer",
			expires_in: 86399,
			scope: "read write app:assignable app:mentionable",
			refresh_token: `refresh-${n}`,
		});
	};
	const linear = {
		workspace,
		clientSecret,
		tokenRequests: [] as Record<string, string>[],
		activities: [] as {
			agentSessionId: string;
			content: { type: string; body: string };
		}[],
		accessTokens: new Set<string>(),
		refreshTokens: new Set<string>(),
		authorize(url: string) {
			const q = new URL(url).searchParams;
			const code = `code-${codes.size + 1}`;
			codes.set(code, {
				clientId: q.get("client_id") ?? "",
				redirectUri: q.get("redirect_uri") ?? "",
			});
			return new URLSearchParams({ code, state: q.get("state") ?? "" });
		},
		async fetch(input: string | URL, init?: RequestInit): Promise<Response> {
			const url = String(input);
			if (url === "https://api.linear.app/oauth/token") {
				const form = Object.fromEntries(
					new URLSearchParams(init?.body as URLSearchParams),
				);
				linear.tokenRequests.push(form);
				if (form.client_secret !== linear.clientSecret)
					return Response.json({ error: "invalid_client" }, { status: 401 });
				const granted = codes.get(form.code);
				const ok =
					form.grant_type === "authorization_code"
						? codes.delete(form.code) &&
							granted?.clientId === form.client_id &&
							granted.redirectUri === form.redirect_uri
						: form.grant_type === "refresh_token" &&
							linear.refreshTokens.delete(form.refresh_token);
				return ok
					? issue()
					: Response.json({ error: "invalid_grant" }, { status: 400 });
			}
			if (url === "https://api.linear.app/graphql") {
				const token = new Headers(init?.headers)
					.get("authorization")
					?.replace(/^Bearer /, "");
				if (!token || !linear.accessTokens.has(token))
					return Response.json(
						{ errors: [{ message: "Authentication required" }] },
						{ status: 401 },
					);
				const { query, variables } = JSON.parse(String(init?.body));
				if (String(query).includes("agentActivityCreate")) {
					linear.activities.push(variables.input);
					return Response.json({
						data: { agentActivityCreate: { success: true } },
					});
				}
				return Response.json({
					data: { organization: { name: linear.workspace } },
				});
			}
			return new Response(null, { status: 404 });
		},
	};
	return linear;
}

/** An AgentSessionEvent webhook's body as Linear sends it, with fewer fields; `prompt` makes it a `prompted` event. */
export function agentSessionEvent({
	sessionId = "session-1",
	email = "uma@example.com",
	prompt,
	signal,
	webhookTimestamp = Date.now(),
}: {
	sessionId?: string;
	email?: string;
	prompt?: string;
	signal?: string;
	webhookTimestamp?: number;
} = {}) {
	const user = { id: "lin-user-1", name: "Uma", email, url: "" };
	return {
		type: "AgentSessionEvent",
		action: prompt === undefined ? "created" : "prompted",
		createdAt: new Date(webhookTimestamp).toISOString(),
		organizationId: "org-1",
		oauthClientId: "lin-client",
		appUserId: "app-user-1",
		webhookId: "webhook-1",
		webhookTimestamp,
		agentSession: {
			id: sessionId,
			creator: user,
			comment: null,
			issue: {
				id: "issue-1",
				identifier: "ENG-7",
				title: "Fix the login button",
				description: "It does nothing on Safari.",
				url: "https://linear.app/acme/issue/ENG-7",
				team: { id: "team-1", key: "ENG", name: "Engineering" },
			},
		},
		agentActivity:
			prompt === undefined
				? null
				: {
						id: randomUUID(),
						agentSessionId: sessionId,
						signal: signal ?? null,
						content: { type: "prompt", body: prompt },
						user,
					},
	};
}

/** A webhook request's raw body and its `Linear-Signature`: the hex HMAC-SHA256 of the body with the webhook secret. */
export function signed(payload: unknown, secret: string) {
	const body = JSON.stringify(payload);
	return {
		body,
		signature: createHmac("sha256", secret).update(body).digest("hex"),
	};
}
