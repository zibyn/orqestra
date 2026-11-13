---
status: accepted
---

# An Agent Definition only says who the Agent is

An Agent Definition used to carry run settings as well as the role: the Models it allowed and its default Model, the thinking levels it allowed and its default level, whether it used memory, and compaction budgets. `resolveTurn` narrowed the User's picks to the Agent's lists, an Agent with none of its Models enabled was offline, a template with its own Models ran its Subagents on them, and memory was on only for Agents an Admin had turned it on for.

None of that depends on the role. Which Model to use and how hard to think is the User's choice for each message; whether to use memory is the User's setting; when to compact depends on the Model's context window and on cost. ChatGPT's GPTs, Claude's Projects and Gemini's Gems expose none of it on the assistant either.

Now an Agent Definition holds its name, description, instructions, Tools and Skills, and whether Users can pick it (`strictObject`, so a stored definition with any other field fails to load; migration 0030 removes them).

- **Model.** Every Agent offers every enabled Model. An Admin marks one as the default (`enabled_model.is_default`, at most one); without one, the first enabled Model is the default. A pick that is no longer enabled falls back to it, and it titles Conversations. An Agent is offline only when it was deleted or no Model is enabled.
- **Thinking.** `resolveThinking` offers every level the Model supports, preferring `low`.
- **Memory.** On for every Agent unless the User turned it off or the Conversation is Incognito; a Subagent, the general worker included, only reads.
- **Subagents** run on their parent's Model and thinking level, whatever their template.
- **Compaction** budgets are Limits (`compactionReserveTokens`, `compactionKeepRecentTokens`), pi's defaults until an Admin changes them.

## Considered options

- **Keep per-Agent overrides, optional.** Lets an Admin pin a translation Agent to a cheap Model or keep it from remembering, but brings back the narrowing, the offline Agents and the form fields for a need nobody has stated. One can be added when someone does.
- **Default Model in the Limits.** One more field there, but it would name a Model that can be disabled or deleted underneath it; on `enabled_model` it goes with the Model.

## Consequences

- Agents that had memory off, such as a translator, now get the Memory Tools and Recall unless the User turns memory off; the release notes must say so.
- Memory Tidying can run on any Agent the User can pick.
- `ORQESTRA_DEFAULT_MODEL`, the fallback for an Agent's default Model, is gone; the Admin marks the default in /console/providers.
