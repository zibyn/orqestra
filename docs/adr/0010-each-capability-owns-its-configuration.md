---
status: accepted
---

# Each capability owns its configuration; there is no central configuration layer

`@orqestra/config` was named for configuration but held every entity an Admin edits in /console (Provider, Model, Agent Definition, Skill, MCP Server, Search Provider, Sandbox Provider, Document Parser, Limits), the User's own Connections, the schemas the browser uses, encryption and the Model runtime. Changing one capability meant reading it, tools, conversations and the api. So the code is split by the capabilities of the GLOSSARY: each capability package edits, loads and runs its own part of the configuration, and only the mechanism for loading configuration (a cached snapshot reloaded on NOTIFY after a write commits) and `secret` sit in db for all of them. An Admin is a permission check on the api's routes, not a package.

Packages are layered, and a package may depend only on packages of a lower layer, never on one of its own layer:

```
L0  db              schema · client · migrations · secret · live(load)
L1  models          Provider · Model · Catalog · prices · Model runtime · connection test
    tools           Search / Sandbox / Parse adapters and their Providers
    mcp             MCP Server · Connection · OAuth · protocol · poll/cancel primitives
    skills          Skill · zip · Skill files · skillBlock
    memory          Memory · its change records
L2  agents          Agent Definition · Turn resolution · reference clean-up · Agent choice
L3  conversations   lifecycle (ADR 0002) · Recall · Spending Limit · Usage · Limits
L4  api · worker    assembly
    web             only each package's /shared entry and @orqestra/api
```

`pnpm check` runs `scripts/layers.mjs`, which reads each workspace package's dependencies and web's imports and fails on an upward, same-layer or cyclic dependency, on a package missing from its table, and on web importing anything but `@orqestra/api` or a `/shared` entry. The table lives in the script, not in another document, and is tightened as each package is created.

## Research

Of the platforms we looked at, most keep a capability's settings with the capability and gate the Admin's edits on the route:

- **Dify** has a service per domain (model providers, tools, datasets, apps), each with its own create, update and delete; an Admin is a decorator on the console controllers.
- **Letta** has a manager per resource (agents, tools, providers, blocks, sources), each owning its table.
- **Mastra** has each primitive (agents, tools, memory, workflows) configured in its own package and registered on one instance; no shared settings module.
- **LobeHub** keeps a model and service per entity (AI providers, AI models, plugins, agents), with server-wide defaults from the environment.
- **Open WebUI** has a router per entity (models, tools, functions, knowledge) guarded by an admin dependency, but also a central `PersistentConfig` for server-wide toggles.
- **LibreChat** configures endpoints and most features in one `librechat.yaml`, read at start; per-User data lives with each feature.

The two with a central place use it for settings read at start or flags with no rules of their own; Orqestra's configuration is entities with validation, tests before saving, secrets and references between them, which is what the per-capability platforms keep together.

## Considered options

- **Keep `@orqestra/config`, split into modules.** Fewer moves, but every capability would still be read in two packages and a symbol could still be imported from several entries.
- **A `settings` or `admin` package over the capabilities.** Names a permission, not a capability, and would again hold every capability's rules.
- **dependency-cruiser for file-level rules.** Finer, but a new dependency for what package dependencies already show; which package writes a table stays an ADR's matter (ADR 0002).

## Consequences

- Each capability has its own snapshot, so one Turn may briefly see two capabilities out of step; an Agent referring to a Model, Tool, MCP Server or Skill it cannot find treats it as unavailable.
- A new package must be given a layer in `scripts/layers.mjs` before `pnpm check` passes.
- An operation spanning capabilities (deleting an MCP Server cancels its Background Calls, deletes it, then removes it from every Agent Definition) is a method of the lowest package that depends on all of them, not a sequence kept by the api.
