---
status: accepted
---

# Memories are tidied by a Scheduled Task the User sets up

ADR 0005 left an offline consolidation step for when Agents writing Memories during their Runs proved too weak. Agents write in the moment, so a wrong or stale Memory stays until some later Run notices it, and a Memory's Index line is carried into every Run meanwhile. Memory Tidying is that step: a Scheduled Task, offered as a ready-made draft on the Memory page, whose Agent lists the Conversations had since it last ran with Recall, reads them and corrects the Memories against them. A Memory read now names the Conversation that last wrote it, so any Agent can open that with Recall to check what the User actually said.

We built it from a Scheduled Task, not a background job of its own, because that already gives everything a tidying needs: a schedule the User owns and can pause, a Conversation per Firing in which every change shows and can be undone, Alerts, Spending Limits, and the User's choice of Agent and Model. No table, worker or console setting is added.

## Considered options

- **A worker job that tidies every User's Memories on its own.** Would tidy without the User asking, but writes nobody watches, outside any Conversation, which ADR 0005 ruled out, and needs a revision history of its own to be undone and a setting for which Model pays for it.
- **Extracting Memories after each Run (Mem0-style).** Rejected again for ADR 0005's reasons.

## Consequences

- A tidying finds when it last ran by searching Recall for its own prompt; a User who rewrites the prompt's first line makes it start again from seven days back.
- It is offered only when some Agent the User can pick uses memory, and changes nothing while the User has memory off.
- It and a Conversation the User has at the same time may write the same Memory; the later write wins, as between any two Runs.
