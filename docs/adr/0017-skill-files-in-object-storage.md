---
status: accepted
---

# Skill files live in object storage

Skill files were kept in Postgres ([0004](0004-skill-files-in-postgres.md)) because Postgres was the only infrastructure Orqestra ran. Since Attachments moved to S3-compatible object storage ([0007](0007-attachments-in-object-storage.md)), which the api and worker need to start, that no longer holds, and two places for uploaded files would be two storage paths to explain and test. So a Skill file's bytes are now an object, and Postgres keeps only the index: the Skill, its versions, and each file's path, size and sha256.

An object's key is `skills/<Skill name>/<sha256 of its bytes>`. A Skill's versions share the files they have in common, so a console edit or a new upload stores only the files that changed, and deleting a Skill deletes everything under its name, with nothing to count or sweep. Every writer of a Skill's objects (a new version, the backfill below, deleting it) holds a lock on the Skill's name (a Postgres advisory lock, held whether a Skill has the name or not) while it puts or deletes them, and puts only the files no version of the Skill already names. A Skill file's put that fails deletes nothing, unlike an Attachment's, whose key no other put has: once the save lets go of the name, the next save may put the same file under the same key and commit a version that names it, and a delete that storage answers after that, which a failed put gives up waiting for, would take the file from that version. What a failed put leaves, if anything (Bun aborts a failed multipart upload itself), is named by no version until a save puts that file again, and deleting the Skill deletes it. A save whose puts fail waits for all of them to end, and fails with what storage answered rather than another put's timeout, logging the rest. Its puts, and the deletion of its objects, give up after 60 seconds, so object storage that stops answering does not hold the lock and a database connection for good.

So that no version ever names a file that is gone, deleting a Skill first deletes its rows, then its objects, holding its name and only if no Skill has it again by then. A Run reading the Skill's files meanwhile finds all of them, or no version, but for one that listed them before the rows' deletion committed and fetches one after its object is gone, a window of milliseconds: that Run fails to read the file. Objects that storage fails to delete, or does not answer for in time, are left there, named by nothing: an upload under that name puts every file again, and deleting the name again deletes them.

The limits of 10 MB and 200 files a Skill stay: they no longer protect Postgres, but an upload is still unzipped in the api's memory, and every Run's Sandbox gets a copy of each Skill it can use.

## Considered options

- **Key by version and path.** Nothing is shared, so no lock is needed to put, but every edit stores every file again, and deleting still has to wait for an upload of a Skill of the same name.
- **One key per sha256 across all Skills.** Shares a little more, but deleting a Skill must find which objects no other Skill names, which needs a reference count or a sweep that races uploads.
- **Keep files from before in Postgres, reading both.** No backfill, but two read paths for as long as such a version exists. Reads do fall back to Postgres for a file with no sha256, which only the window between the migration and the backfill has, and the deploy overlap, when an api of the release before saves one that the next start moves. That fallback goes with the migration that drops the column.

## Consequences

- An upload, edit or deletion holds the lock on the Skill's name, and a database connection, for as long as object storage takes, up to a minute; only other writes to the same Skill wait.
- Files from before stay in Postgres with no sha256 until the api or worker, whichever starts first, moves them a version at a time before serving; run again, after an interruption or by both at once, it moves only what is left. Their bytes stay in the column until a later release drops it, refusing to while any file is not moved.
- Should object storage fail while a Skill is deleted, the Skill is gone all the same, and some of its objects stay until its name is deleted again. A delete that storage answers more than a minute late may still land after an upload under the name has put the same file again, taking it from the new Skill.
