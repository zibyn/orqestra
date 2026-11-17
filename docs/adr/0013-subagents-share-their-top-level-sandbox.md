---
status: accepted
---

# Subagents work in their top-level Conversation's Sandbox

A Subagent used to get a Sandbox of its own, so what it made under `/workspace` reached its parent only as text in its result or as an Attachment, and a parent could not hand it files it had been working on. Now every Conversation of a tree uses the Sandbox of its top-level Conversation (`ensureSandbox` claims it on the root's row, by `root_id`), the way Claude Code's subagents share its working directory and Managed Agents lets brains pass hands to one another. The `subagent` Tool tells the parent so, and to give each Subagent its own paths to write to.

Skills are no longer cleared and rewritten on each Run's first call: the Agents of a tree may allow different Skills, and one Run clearing the folder would take away another's. `/workspace/.skills/.versions.json` records each written Skill's version, and a Run writes only the Skills not there at the version it uses, leaving the others.

## Considered options

- **Keep a Sandbox per Subagent, copying files between them on request.** Isolation stays, but every hand-over is a Tool call and a copy, and the Agent has to know which files the other needs.
- **Mount the parent's files read-only in the Subagent's Sandbox.** orrery offers no shared volume between Sandboxes.

## Consequences

- Agents of one tree, the parent and Subagents running in parallel, can overwrite one another's files; only the briefs keep them apart.
- An Agent is told only of the Skills its own Agent Definition allows, but the files of every Skill a Run of its tree wrote are in the Sandbox.
- Dropping or deleting a Subagent leaves the Sandbox, which goes with the top-level Conversation; Subagents' own Sandboxes from before stay theirs until deleted with them.
- When the Sandbox has to be created again (lost, not just stopped), only the Run that created it writes its Skills again; another Run of the tree that already wrote its own finds them gone until its next Run.
