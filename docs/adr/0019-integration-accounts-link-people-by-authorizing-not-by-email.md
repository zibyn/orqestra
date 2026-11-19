---
status: accepted
---

# An Integration Account links a person to their User by their authorizing as themselves, not by email

An Integration Session used to run as the Orqestra User whose email matched that of the person who started it. That trusts two systems to agree about who owns an address. A Linear guest, a contractor's account or a changed address can each match the wrong User, and the Run then uses that User's Connections, such as their GitHub token. Plane and Slack do not send an email at all, only their own user id. Cursor, Codex and GitHub Copilot all have a person link their account once, through OAuth, the first time they hand the agent work.

- **`integration_account(kind, external_id) → user_id`, one per User and kind.** The key is the id the Integration's events name a person with, so `SessionEvent.from` carries `{ id, name }` and no email. `handleSessionEvent` looks the sender up here. A sender with no account gets an `elicitation` asking them to connect at `${ORQESTRA_URL}/connections` and reply. Their reply then opens the Conversation, as any later event from a session with none does.
- **The proof is an OAuth authorization as that person.** The Connections page starts it through the same OAuth app as the Integration Installation, without `actor=app` and with `WorkSource.accountScope` (`read` for Linear). The callback reads who they are with `WorkSource.account`, stores the id, and revokes the token with `WorkSource.revoke`. Orqestra keeps none of a person's tokens: what the Agent does as the User in Linear stays an MCP Server Connection (ADR 0018).
- **A signed link alone would not do.** The link is posted in a comment anyone in the workspace can read. Anyone signed in to Orqestra who opened it would bind their own User to the sender, who could then direct Runs with that User's Connections. Authorizing at the Integration is what shows the person clicking is the sender.
- **The state is sealed, not stored.** It is `{ account: kind, userId, expiresAt }` encrypted with `ORQESTRA_ENCRYPTION_KEY` (AES-GCM), valid for 10 minutes, and accepted only when the User signed in at the callback is that `userId`. Replaying it within that time links the same User again. The installation's random state cannot decrypt, so both flows share `/api/<kind>/callback`, and the Admin registers no second callback URL.
- **Whoever last authorized as a person holds them.** Authorizing is the proof, so it moves the account from any other User, and replaces the account the User had linked before.
