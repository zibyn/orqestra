---
status: accepted
---

# Background work reports only what is new, and Agents of one tree keep to their own files

Two outside pieces checked Orqestra's design. Anthropic's *Building always-on agents* describes the shape it already has (a durable Inbox, Timers and Scheduled Tasks, Memory with an index and a tidying, Questions as deferred calls, Alerts as the outbox), and names three things it lacked: an agent that remembers what it already reported so it does not repeat itself, a run that may end by sending nothing ("start quiet"), and saving what matters before compaction loses detail. *Worse together* (Anthropic alignment, 2026) found that one coordinator beats a team of peer agents, which is how Subagents already work (the parent decides, Subagents never message one another), but that agents sharing a resource overwrite one another's work and make up what others did, and that a platform guard fixes more of that than instructions do.

So:

- **A Firing is told what the one before reported.** Each Firing starts a new Conversation from the task's prompt alone, so a daily digest repeated itself unless its Agent thought to use Recall. Now the Run's system prompt carries the last reply of the task's latest earlier Firing that replied with any text (looking past up to five that ended quietly), cut to 8,000 characters, with the instruction to report only what changed (`previousReport`). An Incognito Firing gets none and gives none, as Recall never finds one.
- **An Unattended Run may end with nothing to report.** Only an Unattended top-level Run gets `nothing_to_report`. Calling it ends the Run as completed (the Firing, too), but leaves Unread as it was, so no Alert goes out: `alertRun` sends no `completed` Alert for a Conversation that is not Unread.
- **A Subagent starts in a folder of its own.** ADR 0013 left Agents of one tree kept apart only by their briefs. A Subagent's `bash` now runs from `/workspace/subagents/<its Conversation id>`, and its `read` and `attach` resolve relative paths there, so two Subagents writing `report.md` no longer collide. It is told to name the files it leaves, with full paths, in its result. Absolute paths still reach all of `/workspace`.
- **The parent reports only what came in.** The `subagent` Tool tells the parent to pass on only what a Notification says, and to name the Subagents still working instead of guessing their results.
- **Compaction writes a handoff, not a Memory.** pi's summary already has a handoff's sections (goal, progress, next steps). `HANDOFF` adds what Orqestra keeps outside the messages (Subagents, Background Calls, the Timer, a Question, files, Memories touched) and the User's own words where they matter, and tells the summary to say what is not known. It stays with the Conversation. What should outlive the Conversation is still for the Agent or a Memory Tidying to write as a Memory.

## Considered options

- **Writing to Memory before each compaction**, as the article suggests. Rejected: most of what a long Conversation needs to go on is about that Conversation alone, and writing it as Memories would fill every later Run's Memory Index with it.
- **A per-task progress Memory for Firings.** Needs the Agent to write it every time. The previous reply costs nothing to keep, and it is exactly what the User was told.
- **Separate Sandboxes per Subagent again.** Rejected in ADR 0013. A default folder keeps files easy to share and still stops relative paths from colliding.
- **Approval for destructive Tool calls in Unattended Runs** (MCP `destructiveHint`), the other guard both pieces point to. Left for its own decision: it changes how Questions work.

## Consequences

- A task whose Firings are all quiet stops passing its last report on after five quiet Firings in a row.
- A Subagent's files that its parent needs are under `/workspace/subagents/`, so the parent has to read its result to find them.
- The handoff makes summaries somewhat longer, which `compactionReserveTokens` already allows for.
