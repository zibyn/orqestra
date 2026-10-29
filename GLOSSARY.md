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
The reusable description of an Agent: its name, instructions, allowed Models and thinking levels. The same definition can back a Conversation or, later, serve as a subagent.
_Avoid_: Profile, persona, preset

**Model**:
A specific LLM offered by a Provider; an Agent runs on a Model but is not one.
_Avoid_: Agent, engine

**Provider**:
A vendor or endpoint that serves Models, such as DeepSeek or Anthropic.
_Avoid_: Vendor, backend

**Conversation**:
An ordered series of messages between one User and the Agent, owned by and visible only to that User.
_Avoid_: Session, thread, chat

**Turn**:
One user message and the Agent's reply to it, with the Model and thinking level picked for that message. Compaction never splits a Turn.
_Avoid_: Exchange, round

**Run**:
The work of producing one Turn's reply: a queued job a worker picks up, which streams the reply, saves it and can be stopped, or retried once it has failed. A Conversation has at most one Run at a time.
_Avoid_: Job, task, generation
