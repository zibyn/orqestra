// A scripted OAuth authorization server, and the Protected Resource Metadata of the MCP Server it guards, reachable through `fetch`.

/**
 * `resource`'s origin serves its Protected Resource Metadata naming `issuer` as its authorization server; every other origin is an
 * authorization server whose issuer is that origin, so moving `issuer` moves the server. `cimd` and `registration` say whether it
 * supports Client ID Metadata Documents and dynamic registration. `authorize` plays the User approving an authorization URL.
 * `registered` lists the client_ids it handed out.
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
	const as = {
		resource,
		issuer,
		cimd: false,
		registration: true,
		registered: [] as string[],
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
				});
			if (pathname === "/register" && as.registration) {
				const body = JSON.parse(String(init?.body));
				const client_id = `${origin}/client-${++n}`;
				as.registered.push(client_id);
				return Response.json({ ...body, client_id }, { status: 201 });
			}
			if (pathname === "/token") {
				const form = new URLSearchParams(String(init?.body));
				const issued = codes.get(form.get("code") ?? "");
				const basic = new Headers(init?.headers).get("authorization");
				const clientId =
					form.get("client_id") ??
					(basic && atob(basic.replace(/^Basic /, "")).split(":")[0]);
				const challenge = Buffer.from(
					await crypto.subtle.digest(
						"SHA-256",
						new TextEncoder().encode(form.get("code_verifier") ?? ""),
					),
				).toString("base64url");
				if (
					!issued ||
					issued.challenge !== challenge ||
					decodeURIComponent(clientId ?? "") !== issued.clientId ||
					form.get("redirect_uri") !== issued.redirectUri
				)
					return Response.json({ error: "invalid_grant" }, { status: 400 });
				codes.delete(form.get("code") ?? "");
				return Response.json({
					access_token: `access-${++n}`,
					token_type: "Bearer",
					refresh_token: `refresh-${n}`,
					expires_in: 3600,
					scope: "repo",
				});
			}
			return new Response(null, { status: 404 });
		},
	};
	return as;
}
