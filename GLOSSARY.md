# Orqestra

A self-hosted platform where signed-in users talk to an AI agent, with identity delegated to an external identity provider.

## Language

### People and access

**User**:
A person in Polaris' User pool who may use Orqestra, identified by their Polaris `sub`. Orqestra keeps no user records of its own: who may sign in, and with which role, is decided in Polaris. Every User is either an Admin or a Member.
_Avoid_: Account, customer

**Admin**:
A User holding the `orqestra:admin` Entitlement at Orqestra's API in Polaris, allowed to configure Providers, Search Providers, MCP Servers, the Sandbox Provider, Skills and Agent Definitions in the console.
_Avoid_: Superuser, owner

**Member**:
A User allowed to sign in to Orqestra who is not an Admin.
_Avoid_: Normal user, regular user

**Identity Provider**:
Polaris, the external OIDC server that owns the User pool and signs Users in on Orqestra's behalf.
_Avoid_: IdP, SSO server, auth server

### Agent

**Agent**:
A role the user converses with, such as a general assistant or a translator, defined independently of the Model it runs on.
_Avoid_: Bot, assistant, model, persona

**Agent Definition**:
The reusable description of an Agent, maintained by Admins: its name, description, instructions, allowed Models, thinking levels, Tools and Skills, whether it uses memory (off unless the Admin turns it on), and whether Users can pick it. Users start Conversations only with Agents they can pick; any definition can serve as the template for a Subagent.
_Avoid_: Profile, persona, preset

**Subagent**:
An Agent that another Agent starts to carry out one task from a fresh context, in a Conversation of its own nested under the starting one, using an Agent Definition as its template or the built-in general worker. It works in the background and can outlive the Run that started it; when it finishes, its result goes back as a Notification. The starting Agent can send it further instructions, continue it once finished, or stop it; the User can only view and stop it. A Subagent can start Subagents of its own, down to a depth the Admin sets; stopping one stops every Subagent below it, and it has not finished, so sends no Notification, while any Subagent it started is still at work.
_Avoid_: Child agent, worker, delegate

**Notification**:
The input that hands a finished Subagent's result to the Agent that started it. It reaches that Agent between two steps of its current Run, or starts a new Run when none is going. A Subagent the User stopped sends one too, but it waits for the next User message instead of starting a Run, as does one that arrives while the Agent waits on a Question.
_Avoid_: Callback, event, result message

**Alert**:
What Orqestra sends to a User's browser, once they have turned Alerts on there, when background work has a result for them: a top-level Conversation's Run ended other than by the User stopping it, an Agent asked a Question, a Firing failed, or a Scheduled Task was paused or finished on its own. It names the Conversation or Scheduled Task and how it stands, never what the Agent wrote, and opening it shows that Conversation, or the Scheduled Task when no Conversation came of it. A browser already showing that Conversation shows no Alert. A Subagent finishing or a Timer ringing sends none of its own; the Run they lead to does. A Scheduled Task can be set not to alert when it completes, but its failures and Questions always alert.
_Avoid_: Notification (that is a Subagent's result), push, notice, message

**Unread**:
How a top-level Conversation stands once a Run has ended with a reply the User has not seen, until they open it. A Run the User stopped leaves it as it was, and a Subagent's Conversation is never unread itself.
_Avoid_: New, unseen, badge

**Timer**:
What an Agent sets to come back to its own Conversation after a delay of a minute up to a day, such as to check on a long command or an outside result, with a note to itself. When it rings, the note arrives in the Inbox as an input marked as sent by the Timer, not by the User, and wakes the Conversation. A Conversation has at most one Timer set, a new one replacing it; while it waits the Conversation stays idle, and the User sees when it will ring. Only so many may ring since the User's last message. Only a top-level Agent sets one, never a Subagent. The Agent or the User can cancel it, and stopping the Conversation, retrying past the Turn that set it, asking a Question or deleting the Conversation cancels it too.
_Avoid_: Reminder, wakeup, alarm, one-time Scheduled Task

**Question**:
What an Agent asks the User when it cannot go on without them, one per Turn, optionally with a few suggested answers. Asking it ends the Run, and the Conversation waits for the User, showing so after it is no longer Unread, until their next message arrives as the answer; a suggested answer is sent as that message. It never expires; retrying the Turn that asked it, or deleting the Conversation, withdraws it. While it waits, Notifications wait with it, and a Firing whose Conversation ends on one has not failed. Only a top-level Agent asks one; a Subagent that needs something from the User says so in its result.
_Avoid_: Attention, approval, prompt, waiting state

**Scheduled Task**:
A prompt a User sets to be sent to an Agent on a schedule, owned by and visible only to that User: its name, prompt (text only), Agent (one the User can pick), Model and thinking level, schedule (once at a time, every interval, or a cron expression, in the time zone stored on the task), whether its Conversations are Incognito, whether it alerts the User when it completes, and whether it is enabled. Only the User creates it, from scratch or from a Task Draft. Each Firing starts a new Conversation; pausing stops future Firings without stopping one under way, an edit applies from the next Firing, and deleting it leaves the Conversations it started as ordinary ones. Three Firings failing in a row pause it on its own. A one-time task, or one past its end, is finished once it has fired, and is kept until the User reschedules or deletes it.
_Avoid_: Routine, cron job, reminder, automation

**Task Draft**:
A Scheduled Task an Agent proposes in a Conversation, shown to the User as a card with its name, prompt, schedule and next Firing, which creates nothing until the User opens it, adjusts it and saves it as their own Scheduled Task. The Agent fills in only the name, prompt and schedule; the rest starts from the Turn and Conversation it was drafted in. Drafting does not end the Run, and the Agent never learns whether the User saved it. A draft can be saved more than once, each save a new Scheduled Task. Only a top-level Agent drafts one.
_Avoid_: Proposal, suggestion, template

**Firing**:
One time a Scheduled Task comes due: it starts a new Conversation, with its own Sandbox, whose first message is the task's prompt, sent as the User's message but marked as sent by the task. A Firing whose previous Conversation is still running is skipped and recorded; one whose Agent can no longer be picked, or whose Model is disabled, fails.
_Avoid_: Trigger, occurrence, scheduled run, execution

**Inbox**:
Where every input to a Conversation waits, a User message, a Notification, a Timer's note or further instructions to a Subagent, until its Run delivers them between two steps, in the order they arrived.
_Avoid_: Queue, mailbox, pending messages

**Wake**:
What an input does when it arrives in the Inbox of a Conversation that has no Run going: it starts one. Every input wakes its Conversation, except the Notification of a Subagent that was stopped, which waits for the next one.
_Avoid_: Trigger, resume

**Outcome**:
How a Subagent's work stands: queued while it waits for a free slot, running, or how its latest Run ended: completed, partial (cut off at its step limit), failed or stopped. Its Notification carries it. A Conversation's own state is its status instead: idle, running or failed.
_Avoid_: Status (of a Subagent), state, result

**Tool**:
A capability an Agent can call during a Run, such as Search, Scrape or those of an MCP Server, served by an external service rather than by Orqestra itself. A Tool with no service to serve it is unavailable, and Agents that list it run without it.
_Avoid_: Function, plugin, skill

**MCP Server**:
An external service, configured by an Admin, that serves Tools to Agents over the Model Context Protocol. An Agent Definition allows an MCP Server as a whole, and only by naming it; one the Admin has disabled or that cannot be reached is unavailable until it is back, while deleting one removes it from every Agent Definition.
_Avoid_: Connector, integration, plugin

**Skill**:
A folder of know-how in the Agent Skills format, added by an Admin by upload or written in the console: a `SKILL.md` with a name, a description and instructions, plus any reference files, scripts and assets it brings along. Its name identifies it. Every upload or edit makes a new version, and Agents use the current one, which an Admin can roll back to an earlier version. An Agent sees only the name and description of each Skill its Agent Definition allows, and reads the rest or runs its scripts in its Sandbox when a task calls for it; a User can also invoke one explicitly from the composer, the only way to use a Skill marked as not invoked by the Agent. A Skill is not a Tool: it tells an Agent how to do something, and is never a service the Agent calls. Without a Sandbox Provider every Skill is unavailable. Disabling one makes it unavailable until it is enabled again, and deleting one removes it from every Agent Definition.
_Avoid_: Plugin, prompt, template, Tool

**Sandbox**:
The isolated machine where an Agent reads its Skills, runs their scripts and works on files, served by the Sandbox Provider. A Conversation gets one the first time its Agent needs it, whenever a Sandbox Provider is configured, with or without Skills; it sleeps when idle and wakes with its files intact, until the Conversation is deleted. A Subagent gets a Sandbox of its own. Reading and running in it are Tools, served by the Sandbox Provider.
_Avoid_: Container, VM, workspace, code interpreter

**Sandbox Provider**:
The external service that serves Sandboxes, configured by an Admin with its address, credentials and environment template; Orrery is the only one supported, and at most one is configured. All Users' Sandboxes run under its one credential.
_Avoid_: Runtime, execution backend

**Search**:
The Tool that queries the web and returns matching pages.
_Avoid_: Web search, lookup

**Scrape**:
The Tool that reads one web page and returns its content as Markdown.
_Avoid_: Fetch, extract, crawl

**Search Provider**:
An external service that serves Search and Scrape, such as Tavily, Firecrawl or DeepSeek, configured by an Admin with its own API key, independently of any Provider. An Admin picks one Search Provider for Search and one for Scrape; only the Search Providers Orqestra supports can be configured, each at most once.
_Avoid_: Tool Provider, Provider

**Model**:
A specific LLM offered by a Provider; an Agent runs on a Model but is not one. Only Models an Admin has enabled are offered; disabling one removes it from every Agent that allowed it.
_Avoid_: Agent, engine

**Provider**:
A vendor endpoint that serves Models, such as DeepSeek or Anthropic, picked from the Catalog and configured by an Admin with an API key. Each Catalog Provider can be configured at most once.
_Avoid_: Vendor, backend

**Catalog**:
Every Provider and Model Orqestra knows about, with their defaults such as context length. Admins configure Providers and enable Models from it; nothing outside it can be used.
_Avoid_: Preset, registry, template

**Conversation**:
An ordered series of messages between one User and the Agent, owned by and visible only to that User. A Subagent's Conversation is nested under the one that started it and is seen only through it; one started by a Firing records which Scheduled Task started it, and otherwise is like any other.
_Avoid_: Session, thread, chat

**Attachment**:
A file in a Conversation's Sandbox that goes with a message: one the User uploads into the Sandbox with their message, or one the Agent attaches to its reply for the User to download. Orqestra stores only its name and path; the file itself stays in the Sandbox and goes with it.
_Avoid_: Upload, artifact, document

**Turn**:
One input, a user message, a Notification or a Timer's note, and the Agent's reply to it, with the Model and thinking level picked for that input. Compaction never splits a Turn.
_Avoid_: Exchange, round

**Run**:
The work of producing one Turn's reply: a queued job a worker picks up, which streams the reply, saves it and can be stopped, or retried once it has failed. A Conversation has at most one Run at a time; inputs that arrive meanwhile are delivered between its steps, and it ends only once none are left. Each Subagent runs in Runs of its own, and the User stopping a Conversation stops its Subagents too and cancels its Timer.
_Avoid_: Job, task, generation

**Unattended Run**:
A Run started by a Firing's prompt or a Timer's note, in a Conversation where no User message has arrived since, together with the Runs of the Subagents it starts. It stops after a limited number of steps or a limited time, set by the Admin, ending with what it has so far, and is never retried on its own. The User's next message in that Conversation makes its later Runs ordinary ones again.
_Avoid_: Background run, headless run, autonomous run

### Memory

**Memory**:
One note an Agent keeps about a User across Conversations, such as a preference, a fact about them or work in progress, written by the Agent during a Run and shaped like a file: a path, a short description and a Markdown body. Memories belong to the User, not to an Agent: every Agent whose Agent Definition turns memory on reads and writes the same ones, while a Subagent can only read them. A Memory never expires; the Agent updates or deletes it when it turns out stale or wrong. Only the User can see, edit and delete their Memories, not even an Admin; turning memory off leaves them unused until it is turned back on, and they outlive the Conversation that wrote them.
_Avoid_: Fact, profile, note, knowledge

**Memory Index**:
The list of a User's Memories, one line each with its path and description, that an Agent sees as its Run starts; it reads a Memory's body only when it needs it.
_Avoid_: Memory file, summary, profile

**Recall**:
The Tool that finds a User's past Conversations by keyword and opens them, so an Agent can use what was said before even if no Memory holds it. It comes and goes with memory, and never finds an Incognito Conversation.
_Avoid_: Search (that is the web), history search, chat search

**Incognito Conversation**:
A Conversation the User starts with memory off: its Agent neither reads nor writes Memories nor uses Recall, and Recall never finds it. It is chosen when the Conversation starts and cannot be changed afterwards; otherwise it is an ordinary Conversation.
_Avoid_: Private chat, temporary chat
