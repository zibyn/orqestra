// A scripted OAuth authorization server, and the Protected Resource Metadata of the MCP Server it guards, reachable through `fetch`.

/**
 * `resource`'s origin serves its Protected Resource Metadata naming `issuer` as its authorization server; every other origin is an
 * authorization server whose issuer is that origin, so moving `issuer` moves the server. `cimd` and `registration` say whether it
 * supports Client ID Metadata Documents and dynamic registration; `revocation` whether it has a revocation endpoint (RFC 7009) and
 * whether that fails. `authorize` plays the User approving an authorization URL. `registered` lists the client_ids it handed out,
 * `revoked` the revocation requests it received. Refresh tokens rotate, each used once; `accessTokens` and `refreshTokens` hold the
 * live ones (clear them to expire or revoke), `refreshed` counts refreshes, and `rejectClients` answers them `invalid_client`.
 * `guard(fetch)` puts the MCP Server reached through `fetch` behind it: 401 without a live access token.
 */
export function fakeAuthorizationServer({
	resource = "https://mcp.example.com/mcp",
	issuer = "https://as.example.com",
}: {
	resource?: string;
	issuer?: string;
} = {}) {
	const codes = new Map<
		string,
		{ challenge: string; clientId: string; redirectUri: string }
	>();
	let n = 0;
	const issue = (clientId: string) => {
		const tokens = {
			access_token: `access-${++n}`,
			token_type: "Bearer",
			refresh_token: `refresh-${n}`,
			expires_in: 3600,
			scope: "repo",
		};
		as.accessTokens.add(tokens.access_token);
		as.refreshTokens.set(tokens.refresh_token, clientId);
		return Response.json(tokens);
	};
	const as = {
		resource,
		issuer,
		cimd: false,
		registration: true,
		registered: [] as string[],
		revocation: "ok" as "ok" | "fails" | false,
		revoked: [] as { token: string; hint: string | null; clientId: string }[],
		accessTokens: new Set<string>(),
		/** By the client_id they were issued to. */
		refreshTokens: new Map<string, string>(),
		refreshed: 0,
		rejectClients: false,
		guard:
			(mcp: (input: string | URL, init?: RequestInit) => Promise<Response>) =>
			(input: string | URL, init?: RequestInit) => {
				const token = new Headers(init?.headers)
					.get("authorization")
					?.replace(/^Bearer /, "");
				return token && as.accessTokens.has(token)
					? mcp(input, init)
					: as.fetch(input, init);
			},
		/** The redirect's query after the User approves `url`: `code`, `state`, and `iss` as RFC 9207 has it. */
		authorize(url: string) {
			const q = new URL(url).searchParams;
			const code = `code-${++n}`;
			codes.set(code, {
				challenge: q.get("code_challenge") ?? "",
				clientId: q.get("client_id") ?? "",
				redirectUri: q.get("redirect_uri") ?? "",
			});
			return new URLSearchParams({
				code,
				state: q.get("state") ?? "",
				iss: new URL(url).origin,
			});
		},
		async fetch(input: string | URL, init?: RequestInit): Promise<Response> {
			const url = new URL(input);
			const { origin, pathname } = url;
			const r = new URL(as.resource);
			if (origin === r.origin) {
				if (pathname === `/.well-known/oauth-protected-resource${r.pathname}`)
					return Response.json({
						resource: as.resource,
						authorization_servers: [as.issuer],
					});
				return new Response(null, {
					status: 401,
					headers: {
						"www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource${r.pathname}"`,
					},
				});
			}
			if (pathname === "/.well-known/oauth-authorization-server")
				return Response.json({
					issuer: origin,
					authorization_endpoint: `${origin}/authorize`,
					token_endpoint: `${origin}/token`,
					...(as.registration && {
						registration_endpoint: `${origin}/register`,
					}),
					response_types_supported: ["code"],
					code_challenge_methods_supported: ["S256"],
					authorization_response_iss_parameter_supported: true,
					client_id_metadata_document_supported: as.cimd,
					...(as.revocation && {
						revocation_endpoint: `${origin}/revoke`,
					}),
				});
			if (pathname === "/revoke" && as.revocation) {
				if (as.revocation === "fails")
					return Response.json({ error: "server_error" }, { status: 503 });
				const form = new URLSearchParams(String(init?.body));
				as.revoked.push({
					token: form.get("token") ?? "",
					hint: form.get("token_type_hint"),
					clientId: clientIdOf(form, init),
				});
				return new Response(null, { status: 200 });
			}
			if (pathname === "/register" && as.registration) {
				const body = JSON.parse(String(init?.body));
				const client_id = `${origin}/client-${++n}`;
				as.registered.push(client_id);
				return Response.json({ ...body, client_id }, { status: 201 });
			}
			if (pathname === "/token") {
				const form = new URLSearchParams(String(init?.body));
				const clientId = clientIdOf(form, init);
				if (form.get("grant_type") === "refresh_token") {
					if (as.rejectClients)
						return Response.json({ error: "invalid_client" }, { status: 401 });
					const refresh = form.get("refresh_token") ?? "";
					if (as.refreshTokens.get(refresh) !== clientId)
						return Response.json({ error: "invalid_grant" }, { status: 400 });
					as.refreshTokens.delete(refresh);
					as.refreshed++;
					return issue(clientId);
				}
				const issued = codes.get(form.get("code") ?? "");
				const challenge = Buffer.from(
					await crypto.subtle.digest(
						"SHA-256",
						new TextEncoder().encode(form.get("code_verifier") ?? ""),
					),
				).toString("base64url");
				if (
					!issued ||
					issued.challenge !== challenge ||
					clientId !== issued.clientId ||
					form.get("redirect_uri") !== issued.redirectUri
				)
					return Response.json({ error: "invalid_grant" }, { status: 400 });
				codes.delete(form.get("code") ?? "");
				return issue(clientId);
			}
			return new Response(null, { status: 404 });
		},
	};
	return as;
}

/** The client a token or revocation request authenticates as: in the form, or by HTTP Basic. */
function clientIdOf(form: URLSearchParams, init?: RequestInit) {
	const basic = new Headers(init?.headers).get("authorization");
	return decodeURIComponent(
		form.get("client_id") ??
			(basic ? atob(basic.replace(/^Basic /, "")).split(":")[0] : ""),
	);
}
