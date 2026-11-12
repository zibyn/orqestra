---
status: accepted
---

# The Conversation lifecycle belongs to @orqestra/conversations alone

A Conversation's Runs, Inbox, Wakes, Subagents, Notifications and Outcomes had rules (one Run per root under its row lock, a Subagent slot counted by Run, a budget per User message, a Run settled once) that four files kept between them by convention: `packages/db/src/runs.ts`, the web app's `conversations.ts`, and the worker's `run.ts` and `tools.ts`. Retry set a Run going without `ensureRun`, the budget's limit lived in the worker and its reset in the web app, the "Model last used" query was written twice, about fifteen callers sent `saved` events by hand, and the tests reached into the worker from the web package.

Now `@orqestra/conversations` is the only code that writes `conversation`, `inbox`, `message`, `subagent` and `compaction`, and the only one that locks a root. Other packages may read these tables, only joining them for what they show (`@orqestra/memory` joins `conversation` for the title of the Conversation that last wrote a Memory), or reference them by foreign key (`memory_change` goes with its Conversation, ADR 0011); no other package writes them. It has three faces:

- **The User's side** (`list`, `get`, `send`, `retry`, `stop`, `rename`, `delete`, `subagentTranscript`, `stopSubagent`, `subscribe`), each taking the user's id and checking ownership itself. The web app's server functions only authenticate and validate.
- **`serveRuns(handler)`**, which runs the queues' workers, listens for stops, requeues on start and ends failed and stopped Runs, and hands each Run to `handler` as a `RunHandle`: the Turn and transcript, and `deliver`, `save`, `stream`, `compacted`, `finish` and `setTitle`; `attach` and `attachment` for its Attachments, `memories` and `recall`, `timer`, `backgroundCalls` and `subagents`. The handler (the worker's Agent runtime) never touches the database.
- **Metered Model requests.** `run.streamSimple(purpose)` is the Run's only way to a Model: each request is first checked against the User's Spending Limit, throwing `SpendingLimitReached` unsent once it is used up, and recorded as Usage, for that purpose, once its stream ends. The handler gets the config without the Models' own `streamSimple`, so a request that skips the check or the record does not type-check; `serveRuns` also holds each Provider to `providerConcurrency` requests at once.
- **Dependencies given once.** `createConversations` takes everything outside the package (the Capabilities' `current`, Skill files, object storage, the Sandbox Provider's client, MCP's `fetch` and the Users' Connections) once; the handler reaches them through the RunHandle (`streamSimple`, `sandbox()`, which returns the client with the Sandbox, `skillFiles`, `store`, `connections`), so the worker builds none of them twice. Members stay flat: they are not nested by purpose.
- **`run.subagents`** (`start`, `message`, `stop`), which return domain results and throw typed errors (`BudgetExceeded`, `NoSuchSubagent`, `NoSuchTemplate`, `TemplateOffline`). The Tools the model sees, and how a refusal reads to it, stay in the worker.

Every method that changes what a page shows sends its own `saved` event. `@orqestra/db` keeps only the schema, the client and the migrations.

## Considered options

- **Inject the queue and the stop signal as ports**, with an in-memory adapter for tests. There is one adapter (BullMQ on Postgres) and no second one in sight, and the pg backend runs in tests against the real database: a port would only add indirection. They stay internal. The handler's side does get a second adapter, `memoryRun` in `@orqestra/conversations/testing`, because the runtime is worth testing without Postgres; a contract test runs both adapters through the same scenarios.
- **Keep the rules in `@orqestra/db` and slim the callers.** The db package would then carry rules again, and nothing would stop the next caller from writing the tables directly.

## Consequences

- The lifecycle scenarios (Wakes, slots, budget, Stops, retry, requeue, crashes, ownership) are tested in the package, through the real `serveRuns` with a scripted handler and no model. The runtime's (streaming, Tools, compaction, step limits) stay in the worker with pi's faux provider.
- The packages' database tests share one `TEST_DATABASE_URL`, so `pnpm test` runs the workspaces one at a time.
- `subagent.parent_id` and `subagent.template` are gone: a Subagent's Conversation has them as `parent_id` and `agent_id`. The migrations were squashed into one baseline, so existing databases are rebuilt rather than migrated.
