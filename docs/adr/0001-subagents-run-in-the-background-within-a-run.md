# Subagents run in the background within a Run, each saved as its own row

A Subagent used to be one blocking Tool call: the parent Agent handed out a batch of tasks and waited for all of them, and each transcript was written into that Tool result only when the batch ended. One failed task lost the whole batch, the UI showed nothing until the end, and the parent could neither steer nor stop a single Subagent.

Now the parent gets four Tools (`subagent` to start, `subagent_wait`, `subagent_message`, `subagent_stop`). Subagents work in the background, up to `MAX_SUBAGENTS` at once and `MAX_SUBAGENTS_PER_RUN` in all, and each is a `subagent` row rewritten after every step, so the UI follows it live through the usual `saved` event and a crashed worker loses no finished step. See `docs/research/subagent-orchestration.md` for how Claude Code, Codex, OpenCode and Pi do it.

## Considered options

- **Keep the blocking call and harden it** (allSettled, status, timeout, progress over `pg_notify`). Smaller, but it still gives the parent no control while Subagents work, and NOTIFY payloads (8000 bytes) are too small for transcripts.
- **Subagents that outlive the Run and can be continued in later Turns** (OpenCode's child sessions). Rejected for now: it needs a delivery path into a Run that has ended and reworks the Run, queue and compaction.

## Consequences

- A Subagent still ends with the Run's reply: ones the parent did not wait for are stopped, and a crashed worker's are marked stopped when its job fails. Nothing outlives the BullMQ job.
- No nesting: a Subagent gets none of these Tools.
