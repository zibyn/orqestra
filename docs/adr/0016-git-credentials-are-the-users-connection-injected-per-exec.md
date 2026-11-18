---
status: accepted
---

# Git credentials are the User's Connection, injected into each command

Agents clone, push and open pull requests from their Sandbox as the User, so git needs the User's own credential there. Orrery no longer manages Git at all (its ADR-0032): it only resolves Secrets into an Exec by name. Orqestra already keeps a per-User OAuth token, refreshed under a lock, in each User's Connection to a per-User MCP Server, and GitHub's MCP Server accepts a GitHub App's user token (#137). So a Git Host is not a table of its own: it is that MCP Server with three more fields, the host, the username git signs in with and the environment variable the token goes in. Before each bash command the worker takes the User's token from that Connection, writes it to an Orrery Secret named per User and server only when it changed, and creates the Exec with `secrets` naming it plus `env` holding, per host, a `credential.https://<host>.helper` that reads the variable. No token is in the Exec's `env`, `argv` or `stdin`, which Orrery keeps in plain text.

The token is refreshed before the command when it expires within an hour, not on a refusal: git's 401 happens inside the Sandbox, where Orqestra never sees it. GitHub answers a used or expired refresh token with HTTP 200 and `bad_refresh_token`, which, like `invalid_grant`, leaves the Connection needing reconnecting.

## Considered options

- **A GitHub OAuth flow of its own, beside Connections.** Q0 showed the MCP Connection already yields a GitHub App user token with refresh, so a second flow would duplicate PKCE, storage and refresh.
- **The token in the Exec's `env`.** Orrery stores `env` and `stdin` of every Exec in plain text.
- **A Sandbox-level Secret.** It is resolved when the Sandbox is created, so a refreshed token would need the Sandbox restarted, and the Sandbox is shared by every Agent of a Conversation tree.
- **One table per Git platform (Git Provider, Git account link).** A new platform is one more MCP Server row with its host and variable; GitLab and Gitea work the same way.

## Consequences

- Refreshing a GitHub token ends the old one at once, so a command still running on it from another Conversation of the same User fails from then on; the hour's margin makes that rare.
- GitHub's authorization server lists no `revocation_endpoint`, so ending a Connection (the User disconnecting, or an Admin deleting the MCP Server or changing its URL, auth or Client) revokes through GitHub's REST API: `DELETE /applications/{client_id}/grant`, with an access token about to expire refreshed first, since it takes a live one. That ends every token of the User's authorization of the App, the refresh token too, which `DELETE /applications/{client_id}/token` is not documented to do; it also ends their tokens of any other MCP Server on the same App. Their Orrery Secret is left holding the revoked token.
- Commits are not linked to the User's GitHub account unless git's `user.email` is one GitHub knows, such as their noreply address; setting it belongs to the Agent's Git conventions, not here.
- The Agent can read the token inside its Sandbox, whose egress is open. Only the GitHub App's repository scope and permissions bound what a leaked token reaches.
- Each worker process remembers which token it last wrote to each Secret. Another process writing an older token after it wrote a newer one leaves Orrery the older until the next refresh; an Exec refused for a missing Secret (another Sandbox Provider, or a deleted Secret) writes it again and runs once more.
