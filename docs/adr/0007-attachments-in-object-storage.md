---
status: accepted
---

# Attachments live in object storage

Attachments used to be files in the Conversation's Sandbox, with Orqestra keeping only their name and path, so they needed a Sandbox Provider, vanished with the Sandbox, and could not be read by a Tool outside it such as Parse. Now Orqestra keeps every Attachment's original, the User's uploads and the files the Agent attaches, in S3-compatible object storage (RustFS in development and tests), set like Postgres in the deployment's environment and required for the api and worker to start; a Sandbox only ever gets a copy. Unlike Skill files ([0004](0004-skill-files-in-postgres.md)), Attachments are up to 50 MB each and grow with use, so Postgres is the wrong place for them, and keeping the Sandbox as a fallback would mean two storage paths to explain and test.

## Consequences

- `attach` takes a snapshot: the Agent changing the file afterwards changes nothing the User downloads, and downloads no longer wake a Sandbox.
- When a message is sent, its Attachments are copied into the Sandbox at `/workspace/uploads/<name>` if there is a Sandbox Provider, so the Agent reads them where it always has.
- Objects are deleted with their Conversation and with a reply withdrawn by a retry; uploads never sent with a message are swept after a day.
- Parse results are cached beside the original, one per page range.
