---
status: accepted
---

# Skill files live in object storage

Skill files were kept in Postgres ([0004](0004-skill-files-in-postgres.md)) because Postgres was the only infrastructure Orqestra ran. Since Attachments moved to S3-compatible object storage ([0007](0007-attachments-in-object-storage.md)), which the api and worker need to start, that no longer holds, and two places for uploaded files would be two storage paths to explain and test. So a Skill file's bytes are now an object, and Postgres keeps only the index: the Skill, its versions, and each file's path, size and sha256.

An object's key is `skills/<Skill name>/<sha256 of its bytes>`. A Skill's versions share the files they have in common, so a console edit or a new upload stores only the files that changed, and deleting a Skill deletes everything under its name, with nothing to count or sweep. Every writer of a Skill's objects (a new version, the backfill below, deleting it) holds the Skill's row lock while it puts or deletes them, and puts only the files no version of the Skill already names: an S3 put that fails deletes its key, so putting a shared file again could take it from the versions that have it.

The limits of 10 MB and 200 files a Skill stay: they no longer protect Postgres, but an upload is still unzipped in the api's memory, and every Run's Sandbox gets a copy of each Skill it can use.

## Considered options

- **Key by version and path.** Nothing is shared, so no lock is needed to put, but every edit stores every file again, and deleting still has to wait for an upload of a Skill of the same name.
- **One key per sha256 across all Skills.** Shares a little more, but deleting a Skill must find which objects no other Skill names, which needs a reference count or a sweep that races uploads.
- **Keep files from before in Postgres, reading both.** No backfill, but two read paths for as long as such a version exists.

## Consequences

- An upload, edit or deletion holds the Skill's row lock, and a database connection, for as long as object storage takes; only other writes to the same Skill wait.
- Files from before stay in Postgres with no sha256 until the api or worker, whichever starts first, moves them a version at a time before serving; run again, after an interruption or by both at once, it moves only what is left. Their bytes stay in the column until a later release drops it, refusing to while any file is not moved.
- Should object storage fail while a Skill is deleted, the Skill stays with some of its files gone, and deleting it again finishes.
