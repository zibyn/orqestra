---
status: accepted
---

# Polaris owns the User pool; Orqestra keeps no users

Orqestra used better-auth with its own `user`, `session` and `account` tables: Polaris was one way to sign in, next to email and password, and an Admin created Members, set roles and banned users in `/console`. Instance Setup created a Default Admin with a password before anyone could sign in.

Now Polaris is the only way in, through the `@zibyn/polaris` Node SDK: it mounts `/auth/login`, `/auth/callback`, `/auth/logout` and `/auth/session`, and keeps the login in its own encrypted session cookie. Orqestra has no user tables: a Conversation's `user_id` is the Polaris `sub`. Who may sign in is the Application's `requireRole` at Polaris; an Admin is a User whose access token for Orqestra's API (the Application's default API) carries the `orqestra:admin` Entitlement. Users, roles, bans and sign-in methods are all managed in Polaris' console.

## Considered options

- **Keep better-auth as the OIDC client, but drop passwords and user management.** Smaller change, but the local `user`, `session` and `account` tables would stay as a copy of Polaris' pool to keep in sync, and roles would still be stored twice.
- **Read roles instead of Entitlements.** Polaris' SDK checks Entitlements only (Polaris ADR 0035); a Role is a named set of them that Polaris admins can change without touching Orqestra.

## Consequences

- Revoking access or the admin Entitlement takes effect within an access token's lifetime (10 minutes): the SDK finds out on its next refresh. There is no Back-Channel Logout.
- A refresh rotates the refresh token, so every server function and server route must write the SDK's `Set-Cookie` back, and one request reads the session only once (`readUser`).
- Instance Setup, the Default Admin, password sign-in and `/console` user management are gone, along with `ADMIN_EMAIL`, `ADMIN_PASSWORD` and the `OIDC_*` and `BETTER_AUTH_*` env vars.
- Migration `0001_polaris_users` moves the Conversations of Users who had signed in with Polaris to their `sub`. Those of password-only users keep their old id and are hidden, not deleted, until mapped by hand.
