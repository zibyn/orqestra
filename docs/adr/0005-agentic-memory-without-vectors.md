---
status: proposed
---

# Memory is file-shaped notes the Agent searches itself, without vectors

A User's Memories are small file-shaped notes (path, description, Markdown body) stored in Postgres, which the Agent writes during a Run through its own Tools and finds by reading the Memory Index and grepping, the way Claude Code keeps its memory directory. Past Conversations are found through Recall, keyword matching over message text with a `pg_trgm` index. We chose this over a Mem0-style pipeline that extracts facts after each Run and retrieves them by embedding similarity, because every write is visible to the User in the Conversation and can be undone, nothing runs outside a Run, and Postgres stays the only infrastructure: no embedding Model, no vector index, no re-embedding when Models change. The cost is that finding things depends on the Agent picking good keywords; if that proves too weak, an offline consolidation step can be added before reaching for vectors.

## Consequences

- Postgres full-text search (`tsvector`) is not used: it does not segment Chinese. Keywords shorter than three characters fall back to a scan of the User's own rows.
- Memories live outside the Sandbox, which is optional and dies with its Conversation.
- Subagents only read Memories, so every write traces back to a Conversation the User sees.
