---
status: accepted
---

# Every channel people hand work in through is a WorkSource: Plane, Slack, Feishu, WeCom and email join Linear

People should reach the same Agent from where they already work: an issue tracker (Linear, Plane), a chat (Slack, Feishu, WeCom), or their inbox. Each of these has an agent or bot app that is mentioned, written to or assigned work, and that answers as itself. The Conversation lifecycle of an Integration Session (ADR 0015, 0018) already knows nothing of Linear: one session opens one Conversation, a Run closes its turn once with a `thought`, `response`, `elicitation` or `error`, and only the session's own User may direct it. What assumes Linear is the `WorkSource` port, in four places. Each is widened only when the first channel that needs it lands.

| The port assumes | Which channels break it | What it becomes |
|---|---|---|
| The work comes from an issue, whose team's key the Admin maps to a repository | Chats have channels and groups, not issues | `SessionEvent.scope`, the key the Admin maps in `scope_repos`: a Linear team key, a Plane project, a Slack channel, a Feishu or WeCom chat |
| The app installs by OAuth (`authorize`, `tokenUrl`, `workspace`) | A Feishu or WeCom self-built app trades its app id and secret for a token; email takes an IMAP and SMTP account | `install: { mode: "oauth", … } \| { mode: "credentials", fields, token }` |
| Events arrive by webhook, answered 200 or 401 | Slack and Feishu ask the webhook to answer a challenge; WeCom encrypts its callbacks; Feishu, WeCom's AI bot and Slack's Socket Mode push events over a long connection, which needs no public address; email is polled | `ingress: { mode: "webhook", receive → { response?, event? } } \| { mode: "stream", connect } \| { mode: "poll", poll }`, each queueing into `<kind>-events` under the channel's own event id |
| A person proves who they are by OAuth as themselves | WeCom's OAuth needs a trusted domain; email has none | `proof: { mode: "oauth", … } \| { mode: "private-link" }` |

- **A private link proves the sender only where only the sender sees it.** ADR 0019 refused a signed link because a Linear comment is read by the whole workspace. A Slack DM or ephemeral message, a Feishu or WeCom one-to-one chat, and a reply mail to the sender's address are read only by the sender, so whoever opens the link from there is them. The link carries the sealed `{ account: kind, externalId, expiresAt }`, accepted for 10 minutes by whichever User is signed in when it is opened. Linear and Plane keep OAuth.
- **Each channel names its own session.** Linear's Agent Session, Plane's Agent Run, Slack's `channel:thread_ts`, a Feishu thread's `root_id`, an email thread's first `Message-ID`. WeCom has no threads, so each chat is one rolling session, and `/new` starts another.
- **Each channel maps the four Activities onto what it shows.** Linear and Plane take them as they are. Slack shows a `thought` as the session's `processing` status and must set it back to `active` itself, or it stays for an hour. Feishu posts a card for the `thought` and updates it with the closing activity. WeCom's AI bot streams a reply left open by the `thought` and finished by the closing activity. Email sends no `thought`.
- **Only one-to-one chats reach the Agent until the Admin opens a channel.** A Run works with its User's Connections, and its reply in a group is read by everyone there. The Admin lists the channels or groups the app answers in, beside `scope_repos`.
- **An email is acted on only when a DKIM signature aligned with its `From` covers the whole body.** IMAP gives no connecting IP, so SPF, and with it a DMARC pass, cannot be checked; mail over 48 hours old, auto-replies, bounces and lists are dropped too. An Admin may also trust the `dmarc=pass` of the topmost `Authentication-Results` their own provider writes, by its authserv-id.
- **Only the session's User may stop it or start it afresh.** Anyone else in a group or an issue gets an error, as they do for any other message.
- **A source may refuse a sender before any work** (`accept`): GitHub takes work only from people with write access to the repository, then adds 👀 where it was asked.
- **A link is never consumed on opening.** Link scanners in mail open links first, so `/connections?link=` shows whom it links and the User's click links them. A person is sent one at most every 10 minutes.
- **Some Integrations allow one connection per installation** (`exclusive`: WeCom's bot, and an IMAP mailbox, where Gmail allows 15). Only the worker holding a Postgres advisory lock for the kind connects, and every post and private link of that kind goes through the `<kind>-posts` queue that worker serves, since WeCom answers only down that connection. A connection taken over elsewhere is retried after a backoff, never at once, so two holders cannot take it from each other forever. Feishu hands each event to one of up to 50 connections, so every worker holds one.

## Considered options

- **One generic bot framework (Botkit, Bot Framework) behind one WorkSource.** It covers Slack but not Feishu, WeCom, Linear or Plane, and puts a second session model under ours.
- **An MCP Server per channel.** ADR 0018 already says why not: a WorkSource pushes work in and answers at moments the Run lifecycle sets, which the Agent never chooses.
- **All four unions in the port at once.** Only Linear would implement them, so each would be a wrapper with one variant. Each lands with its first second variant: `scope` now, `receive`'s response with Slack, `install` and `stream` with Feishu, `poll` with email.

## Consequences

- Migration 0040 renames `integration_installation.team_repos` to `scope_repos`, and `SessionEvent.issue.teamKey` becomes `SessionEvent.scope`. A Linear event queued across that deploy opens its Conversation without the repository line.
- GitHub, Feishu, WeCom and email landed first, Plane and Slack later. Each adapter follows the platforms below where they agree. A GitHub App is assumed installed once (`installationId`); events of its other installations are dropped. Microsoft 365 mailboxes, which need OAuth for IMAP, are not supported.

## Research

Each adapter was checked against code, not only docs:

- **GitHub:** claude-code-action (trigger phrase, `User` senders only, write permission, sanitizer), OpenHands' resolver (👀, collaborator permission; its org-membership fallback passes anyone), Copilot, Devin and Cursor (write access, one session per issue or PR). An ordinary App cannot be assigned an issue, and GitHub does not redeliver a failed webhook.
- **Feishu:** OpenClaw, cc-connect, Qwen Code, LangBot, AstrBot. Long connection by default; dedupe by `message_id`, not `event_id`; the SDK acks only once the handler returns, within 3 seconds; reply to the message, not into a topic; an `OnIt` reaction while working.
- **WeCom:** the WeCom team's own OpenClaw plugin, Qwen Code, chatgpt-on-wechat, LangBot. The AI bot's long connection; one connection per bot, a new one taking it over; streamed replies end within about 6 minutes, so answers are pushed; userids are opaque unless the super-admin made the bot.
- **Email:** OpenClaw's IMAP plugin (read-only INBOX, a `{uidValidity, lastUid}` cursor, its sender gate), GitLab mail_room and n8n (one connection per mailbox), Discourse and RFC 3834 (auto-reply guards), crisp-oss/email-reply-parser.
