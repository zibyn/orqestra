# Orqestra

A self-hosted platform where signed-in users talk to an AI agent, with identity delegated to an external identity provider.

## Language

### People and access

**User**:
A person with an account in Orqestra. Every user has exactly one role: Admin or Member.
_Avoid_: Account, customer

**Admin**:
A user with the `admin` role, allowed to manage users and instance settings.
_Avoid_: Superuser, owner

**Member**:
A user with the `user` role; the default for everyone who is not an Admin.
_Avoid_: Normal user, regular user

**Default Admin**:
The first Admin, created during Instance Setup before anyone else can sign in.
_Avoid_: Root, bootstrap user

**Instance Setup**:
The one-time process that creates the Default Admin; it can no longer run once any Admin exists.
_Avoid_: Onboarding, installation

**Identity Provider**:
The external OIDC server (Polaris) that authenticates users on Orqestra's behalf.
_Avoid_: IdP, SSO server, auth server

### Agent

**Agent**:
A role the user converses with, such as a general assistant or a translator, defined independently of the Model it runs on.
_Avoid_: Bot, assistant, model, persona

**Agent Definition**:
The reusable description of an Agent, maintained by Admins: its name, description, instructions, allowed Models, thinking levels and Tools, and whether Users can pick it. Users start Conversations only with Agents they can pick; any definition can serve as the template for a Subagent.
_Avoid_: Profile, persona, preset

**Subagent**:
An Agent that another Agent starts to carry out one task from a fresh context, in a Conversation of its own nested under the starting one, using an Agent Definition as its template or the built-in general worker. It works in the background and can outlive the Run that started it; when it finishes, its result goes back as a Notification. The starting Agent can send it further instructions, continue it once finished, or stop it; the User can only view and stop it. A Subagent cannot start Subagents of its own.
_Avoid_: Child agent, worker, delegate

**Notification**:
The input that hands a finished Subagent's result to the Agent that started it. It reaches that Agent between two steps of its current Run, or starts a new Run when none is going. A Subagent the User stopped sends one too, but it waits for the next User message instead of starting a Run.
_Avoid_: Callback, event, result message

**Inbox**:
Where every input to a Conversation waits, a User message, a Notification or further instructions to a Subagent, until its Run delivers them between two steps, in the order they arrived.
_Avoid_: Queue, mailbox, pending messages

**Wake**:
What an input does when it arrives in the Inbox of a Conversation that has no Run going: it starts one. Every input wakes its Conversation, except the Notification of a Subagent that was stopped, which waits for the next one.
_Avoid_: Trigger, resume

**Outcome**:
How a Subagent's work stands: queued while it waits for a free slot, running, or how its latest Run ended: completed, partial (cut off at its step limit), failed or stopped. Its Notification carries it. A Conversation's own state is its status instead: idle, running or failed.
_Avoid_: Status (of a Subagent), state, result

**Tool**:
A capability an Agent can call during a Run, such as Search or Scrape, served by an external service rather than by Orqestra itself. A Tool with no service to serve it is unavailable, and Agents that list it run without it.
_Avoid_: Function, plugin, skill

**Search**:
The Tool that queries the web and returns matching pages.
_Avoid_: Web search, lookup

**Scrape**:
The Tool that reads one web page and returns its content as Markdown.
_Avoid_: Fetch, extract, crawl

**Search Provider**:
An external service that serves Search and Scrape, such as Tavily, Firecrawl or DeepSeek, configured by an Admin with its own API key, independently of any Provider. An Admin picks one Search Provider for Search and one for Scrape; only the Search Providers Orqestra supports can be configured, each at most once.
_Avoid_: Tool Provider, Provider

**MCP Server**:
A remote service an Admin configured that serves Tools over the Model Context Protocol. An Agent gets its Tools only when its Agent Definition names it explicitly; an Agent Definition without a Tool list, and a Subagent without a template, get Search and Scrape but no MCP Server. A disabled or unreachable MCP Server is unavailable for the Run.
_Avoid_: MCP, connector, plugin

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
An ordered series of messages between one User and the Agent, owned by and visible only to that User. A Subagent's Conversation is nested under the one that started it and is seen only through it.
_Avoid_: Session, thread, chat

**Turn**:
One input, a user message or a Notification, and the Agent's reply to it, with the Model and thinking level picked for that input. Compaction never splits a Turn.
_Avoid_: Exchange, round

**Run**:
The work of producing one Turn's reply: a queued job a worker picks up, which streams the reply, saves it and can be stopped, or retried once it has failed. A Conversation has at most one Run at a time; inputs that arrive meanwhile are delivered between its steps, and it ends only once none are left. Each Subagent runs in Runs of its own, and the User stopping a Conversation stops its Subagents too.
_Avoid_: Job, task, generation
