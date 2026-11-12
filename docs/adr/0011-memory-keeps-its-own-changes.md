---
status: accepted
---

# Memory keeps its own record of changes

A User undoes an Agent's Memory change from the Conversation it was made in (ADR 0005). Undoing used to find the Tool call's result among the Conversation's messages and decode the `details` the worker's Memory Tools wrote there (`before`, `after`, `old`, `new`), so the format of a Tool result was a contract between the worker, `@orqestra/conversations` and the Memory code, and nothing but convention kept the three in step.

Now `@orqestra/memory` records each change an Agent's Memory Tool call makes in `memory_change`, in the same transaction as the write: the Conversation, the Tool call, the path, the Memory before (and the Conversation that wrote it then), and the Memory as the call left it. `undoChange` finds the change by Conversation and Tool call, refuses when the Memory is no longer as the call left it, so a later change is never lost, and restores the Memory before. `undoMemory` in `@orqestra/conversations` only checks that the Conversation is the User's, calls it, and marks the Tool result undone in the same transaction, since `message` stays its own. The `details` stay in the result, to show the change, but nothing reads them to undo.

A change goes with its Conversation (`on delete cascade`); the Memory stays, as before. The migration fills `memory_change` from the Memory Tool results not yet undone, so what could be undone before still can.

Memory's refusals are of two kinds, `InvalidMemory` and `MemoryNotFound`, so the api maps them straight to 422 and 404 instead of checking the limits first to tell them apart.

## Considered options

- **Memory defines the Tool result's format and decodes it.** Moves the decoding into one package but keeps undo dependent on what the worker saves in a message, and on a Run having saved it; the worker could still change the shape without Memory noticing.
- **A full revision history of every Memory.** Would also undo the User's own edits and let a tidying be rolled back as a whole, but nothing asks for that; one record per Tool call is what undo from the Conversation needs.

## Consequences

- A change is recorded only with a Tool call's id: the Memory page's edits and deletes are not undoable from a Conversation, as before.
- A change is undone at most once; `memory_change.undone` says so, under the User's advisory lock that serializes their Memory writes.
- A Tool result already undone before the migration has no record: undoing it again answers not found rather than already undone.
