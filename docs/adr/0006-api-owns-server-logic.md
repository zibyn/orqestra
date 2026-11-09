---
status: accepted
---

# The api owns all server logic; web only renders

Web was a TanStack Start app on Node whose server functions and server routes read Postgres, ran `@orqestra/conversations` and held the Polaris session. Now an `apps/api` service, Elysia on Bun, owns all of that: every server function and `/api/*` route moves there, and so do Polaris' `/auth/*` routes, so web no longer depends on `@orqestra/db`, `@orqestra/conversations` or `@zibyn/polaris`. Web renders pages and fetches their data from the api with Eden Treaty, typed by the api's `App`. A Caddy service in front sends `/api/*` and `/auth/*` to the api and everything else to web, so the browser sees one origin. The api is internal to Orqestra, not a public API.

We split them so that SSE and uploads, which hold connections open, scale apart from SSR, and so that all the backend runs on Bun, like the worker.

## Considered options

- **Move only the four raw HTTP routes, keep server functions in web.** Smaller, but Postgres access and the session would then live in two services.
- **Web keeps the Polaris session and passes an internal Bearer token to the api.** Refreshes stay in web, but every browser call to `/api/*` would have to go through web's proxy to swap the cookie for a token.
- **No SSR data: web renders skeletons and the browser fetches everything.** The simplest session handling, but every page flashes before its data arrives.
- **Nitro's proxy instead of Caddy.** One service fewer, but SSE and uploads would still pass through web.

## Consequences

- A refresh rotates Polaris' refresh token, and two requests that present the same one end the Polaris Session. So web's SSR calls `/api/session` first, alone, writes its `Set-Cookie` back to the browser, and only then calls other endpoints, concurrently, with the refreshed cookie.
- Errors are HTTP status codes (401, 403, 404, 413, 422) with an `{ errors: { <field>: { code } } }` body, as `/api/skills` already returned.
- A fourth image, `orqestra-api`, ships next to `web`, `worker` and `migrate`.
