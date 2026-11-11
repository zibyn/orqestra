---
status: accepted
---

# Orqestra remembers the Users who have used it

ADR 0003 left Orqestra with no user records: a User was only a Polaris `sub`. But Usage, Spending Limits and, later, audit logs are Orqestra's own data about a User, and an Admin needs to see who a `sub` is and set things for them, so Orqestra now keeps one row per User who has used it, written when a signed-in request reads the session (the Polaris SDK has no sign-in hook): their name and email from the token's claims, rewritten only when they change, and when they were last active, updated at most hourly, together with the settings it keeps for them, such as their own Spending Limit. This amends ADR 0003 only where it said Orqestra keeps no users: signing in, roles, Entitlements and bans stay in Polaris, and whether a User is an Admin is still read from their access token on every request, never stored.

## Considered options

- **Keep no records and snapshot names into each Usage row.** Works for showing names, but leaves nowhere to keep per-User settings, and Users can only be found through their Usage.
- **Sync the whole Polaris User pool.** Would list Users who never signed in, but needs Polaris' admin API and a sync job; a User only needs settings once they use Orqestra.

## Consequences

- A User removed or banned in Polaris keeps their row (and Usage); their last-active time simply stops moving. Users who signed in before this appear on their next visit.
- The console gains a Users page listing these rows, where an Admin sets a User's own Spending Limit.
- Usage no longer snapshots the User's name; it shows the current name from this row. Agent names are still snapshotted; a Model shows its Catalog name.
