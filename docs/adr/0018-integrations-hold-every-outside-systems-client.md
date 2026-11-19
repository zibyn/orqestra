---
status: accepted
---

# `@orqestra/integrations` holds every outside system's client, one directory per system

v0.2.0's worker crashed at start. `apps/worker/src/linear.ts` imported `drizzle-orm` at runtime, but the image left `drizzle-orm` out, since it was only a devDependency. The missing dependency was the symptom. The cause was that Linear's code had no home. Its parts sat in five places: `packages/linear` (L1) for OAuth and the webhook, raw SQL in the worker on `linear_session`, `linear_installation` and `user`, the worker's wiring, the api's routes, and `send` in conversations, which inserted `linear_session`. The vendor clients of Search, the Sandbox Provider and the Document Parser also sat in `packages/tools`, beside the rules that use them. So the code now splits into clients and capabilities. Every capability moves up one layer, since a package may depend only on a lower one:

```
L0  db              schema · client · migrations · secret · live(load) · ObjectStore
L1  integrations    ports.ts · linear/ · orrery/ · mineru/ · tavily/ · firecrawl/ · deepseek/ · s3/ · Integration Installation
L2  models · tools · mcp · skills · memory   (each picks its client by kind)
L3  agents
L4  conversations   lifecycle (ADR 0002) · Integration Session
L5  api · worker    assembly
```

- **One directory per outside system, clients only.** Each directory holds a client for its system: auth and token refresh, requests, verifying and parsing webhooks, and posting back. It holds no rules of the capability that uses it. `ports.ts` says what each kind of system offers. `SearchClient`, `SandboxClient` and `ParserClient` are what Agents call out to. Tools picks a Search Provider's client by its id, and builds the Parse Tool on a `ParserClient`. `WorkSource` is a system that pushes work in, like Linear: its OAuth endpoints, `event` (verify and parse a webhook), `post` (an activity) and `firstMessage`. The capability packages type against the ports and pick the adapter by kind. `models` and `mcp` keep their own clients: pi-ai makes the Model calls, and MCP is a protocol rather than one system. The Git host stays in `mcp` (ADR 0016).
- **The Integration Installation is configuration, so it lives with the clients.** `integration_installation` has one row per `kind`. It holds the OAuth app's credentials, the tokens, the workspace, the Agent and the repository of each team. Like any capability's configuration (ADR 0010), it is edited, loaded and refreshed by the one package that owns it. `integrations` depends only on `db`: whether the Agent named there exists is left to the row's foreign key, not to a read of `agent`.
- **The Integration Session is part of the Conversation lifecycle, so it lives in conversations.** `integration_session(kind, session_id, conversation_id unique, closed_job_id)` replaces `linear_session`. ADR 0002 already gives conversations the lifecycle, and `send` already inserted the session's row in the transaction that inserts the Conversation (ADR 0015). `sessions.ts` adds what the worker did by hand:
  - `handleSessionEvent`: the User by their Integration Account (ADR 0019), one session for one Conversation, and a stop.
  - `reportingToSessions`, which wraps the worker's RunHandler, and `reportSessionFailure`, which is `onFailed`. Each closes a Run's turn once by claiming `closed_job_id`, the claim modelled in `verify-formal-run-lifecycle`.
- **The api and the worker only assemble.** The worker serves `serveEvents(linear, …)` and `serveTokenRefresh(linear, …)`, and wraps its RunHandler. The api mounts the routes on `/api/linear` and passes `linear`. The queues keep their names, `<kind>-events` and `<kind>-tokens`, so a deploy keeps both the waiting events and the refresh schedule.

`scripts/layers.mjs` enforces this with selfCheck cases. `integrations` may depend on no package but `db`. Other packages reach it only through its entries (`@orqestra/integrations`, `/<directory>`, `/testing`), never a file inside an adapter's directory. The apps' runtime source imports no `drizzle-orm`, and the apps list it only in devDependencies. CI's docker job also bundles `src/index.ts` inside the api and worker images, so a runtime dependency an image lacks fails CI instead of the deploy. On v0.2.0's worker image, that step fails with `Could not resolve: "drizzle-orm"`.

## Why a WorkSource is not an MCP Server

An MCP Server is called by the Agent: a Tool call the Agent decides to make, as the User, with the User's Connection. A WorkSource runs the other way. It pushes work in by webhook, and it expects its replies from Orqestra's app as itself (`actor=app`), at moments the Run lifecycle sets: a `thought` within 10 seconds of a session's start, then one closing activity per Run. The Agent never chooses to make those posts, so they cannot be Tool calls. Reading and editing issues as the User is something an Agent chooses to do, and stays an MCP Server, such as Linear's own.

## Research

- **OpenHands** keeps each outside system under `enterprise/integrations/<system>/` (GitHub, GitLab, Jira, Linear, Slack). Each system's manager there turns that system's webhooks into conversations and posts back to it, and the agent core does not know of them.
- **Dify** keeps its core split by capability (models, tools, RAG, workflow) and puts outside systems in plugins sorted by kind (model, tool, agent strategy, extension). The capability decides what it does with a plugin, and the plugin only talks to its system.
- **n8n** keeps one directory per vendor in `packages/nodes-base/nodes/<Vendor>/`, with the vendor's credentials beside the nodes, and the workflow engine reaches them through one node interface.

All three keep a vendor's client in one place sorted by vendor, and keep the rules that use it in the core.

## Considered options

- **A Linear-only package.** That would be `packages/linear` again, and Plane would add another. The rules every WorkSource shares (the User by email, one session for one Conversation, closing a turn once) would be copied into each.
- **A `trackers` package above conversations, holding the sessions too.** It would own both tables. But the apps would have to move up again, and conversations would need a callback in `send` to insert a row it does not own, even though the session lives and dies with its Conversation.
- **Leave the vendor clients in `tools`.** It is a smaller diff, but `tools` would keep mixing what an Agent may call with how each vendor is reached. The next Search Provider would again be written beside the Tool rules.

## Consequences

- This supersedes ADR 0010's placement of the Search, Sandbox and Parse adapters and of `packages/linear`. ADR 0010's rule that each capability owns its configuration stands, and this decision applies it to the Integration Installation. ADR 0015 still holds for Linear, which is now a `WorkSource` of kind `linear`.
- Migration 0038 copies `linear_installation` and `linear_session` with their rows into `integration_installation` and `integration_session` (kind `linear`), then drops the old tables.
- A new WorkSource is a directory implementing `WorkSource`, a `kind`, an entry in conversations' `SOURCES`, and the api's and worker's assembly. Its queues, tokens and turns come with it.
