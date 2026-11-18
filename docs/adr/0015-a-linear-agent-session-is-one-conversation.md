---
status: accepted
---

# A Linear Agent Session is one Conversation

When someone in the Linear workspace of the Integration Installation delegates an issue to Orqestra's app or mentions it, Linear starts an Agent Session and sends the app's webhook a `created` event. Each later message in that session arrives as a `prompted` event. Orqestra opens one Conversation per Agent Session, Linear's name for an Integration Session. `integration_session(kind, session_id, conversation_id unique)` records which, with kind `linear` (ADR 0018 says where the code lives).

- **The webhook only checks and queues.** Linear counts a delivery that takes over 5 seconds as failed and retries it. `POST /api/linear/webhook` needs no sign-in. It checks `Linear-Signature`, the hex HMAC-SHA256 of the raw body with the installation's webhook secret. It then checks that the signed `webhookTimestamp` is within a minute of now, and answers 401 if either check fails. It queues the event in BullMQ's `linear-events` queue under a job id per session start or prompt, so a redelivery queues nothing for a day. The worker takes the events one at a time, in order.
- **The Linear user's email names the User.** The Conversation belongs to the Orqestra User whose email matches, ignoring case, the email of the person who started the session or wrote the prompt. When no User matches, the session gets an `error` activity that asks the person to sign in first, and their next prompt in the session opens the Conversation. Only the session's own User's prompts reach it, since it runs with that User's Connections.
- **The first message is the issue.** It holds the issue's identifier, title and link, then the repository the installation maps the issue's team to, then the description and the comment that mentioned the app. It goes to the installation's Agent, or to the default Agent when none is set. Every message from Linear is a User message marked `origin: linear`, so its Runs are Unattended Runs until the User writes in Orqestra. A `prompted` event that carries the `stop` signal stops the Run instead.
- **One session opens one Conversation however often it arrives.** `send` in `@orqestra/conversations` inserts the `integration_session` row in the transaction that inserts the Conversation. A redelivered or concurrent `created` event waits on the primary key, finds the row, and rolls back its own Conversation. The worker then posts a `thought` activity, which Linear needs within 10 seconds of the session's start, or it marks the session unresponsive.

## Considered options

- **Handle the event in the webhook request.** Opening a Conversation and calling Linear's API, which may refresh the app's token for up to 30 seconds, would fall inside Linear's 5-second deadline.
- **Write the session's row in the worker after `send` returns.** A crash between the two leaves a Conversation with no session, and the retry opens a second one.
- **A Linear column on `conversation`.** Every Conversation would carry a Linear field. The separate table stays out of the way and goes with its Conversation.
- **An account link that each User makes from Orqestra to Linear.** It proves who is who, but every User has to make the link before Linear works for them. The email match trusts that the email Polaris gives a User and the one Linear gives a person belong to the same person.

## Consequences

- When a User deletes a Conversation, its `integration_session` row goes too, so the session's next prompt opens a new Conversation.
- When a Run of the Conversation ends, the worker posts how it ended to the session: the last reply as a `response`, a Question as an `elicitation`, and a failure as an `error`. A `stop` is confirmed with a `response`, and the stopped Run posts nothing more. The Tool calls in between are not posted.
- Linear's refresh token lapses 30 days after it was issued, so the worker checks the app's tokens daily and refreshes them when due, with or without an event. When Linear refuses a refresh, /console/linear says the app must be installed again.
