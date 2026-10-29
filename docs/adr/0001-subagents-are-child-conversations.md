---
status: accepted
---

# Subagents are child Conversations that wake the Agent that started them

A Subagent used to live inside its parent's Run: the parent had to call `subagent_wait` to get results, and any Subagent it had not waited for was stopped with the reply. Models forget to wait, the parent cannot answer while it waits, and work is thrown away at the end of every Run.

Now a Subagent is a **child Conversation** with Runs of its own, the way Claude Code runs background agents. The parent starts it and goes on; when it finishes, a **Notification** carrying its result enters the parent's inbox. If the parent has a Run going, the Notification is delivered between two of its steps; if not, it starts a new Run, so the parent is woken rather than polling. Everything that reaches a Conversation (User messages, Notifications, messages from the parent to a Subagent) goes through one durable inbox, and a Run only goes idle once the inbox is empty, checked under the Conversation's row lock. See `docs/design/subagent-sessions.md` for the data model and flows, and `docs/research/subagent-orchestration.md` for how Claude Code, Codex, OpenCode and Pi do it.

## Considered options

- **Wake within one Run** (keep the Run open until its Subagents finish and feed results back as follow-ups). Smaller, but nothing outlives the job: a Run waits on Subagents for minutes, the User cannot write meanwhile, and a crash or deploy loses all of them.
- **Subagents detached from the Run but still in the worker's process.** No new queue, but a restart loses them and a Conversation's Subagents cannot spread across workers.
- **Deliver results with `pg_notify` to the live Run.** NOTIFY is lost when nobody listens, and the payload is capped at 8000 bytes; the inbox is a table, NOTIFY only streams.
- **Keep the `subagent` row with its transcript as JSON.** Rewriting the whole transcript after every step costs O(n²), and it would need its own retry, compaction and streaming; a child Conversation reuses the parent's.

## Consequences

- A Subagent outlives the Run that started it. It ends when it finishes, when it is stopped, or when its Conversation is deleted. The starting Agent can continue a finished Subagent by sending it a message.
- A Turn now starts from an input: a User message or a Notification. Retry and compaction treat both alike.
- Still no nesting: a Subagent cannot start Subagents.
- The User's Stop stops the Conversation's Run and all its Subagents; their Notifications are delivered with the next User message instead of waking the Agent.
- A User message sent while a Run is going waits in the inbox and is delivered between two steps, instead of being refused.
- The User can view and stop a Subagent but not write to it, so its result always goes to the Agent that started it.
- `subagent_wait` goes. Without a limit, Notifications could keep waking an Agent that keeps delegating, so each User message has a budget of Subagent starts and continuations.
