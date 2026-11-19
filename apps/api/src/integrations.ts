import {
	accountOf,
	accountState,
	callbackUrl,
	conversationsInput,
	credentialsInput,
	credentialsStatus,
	type Fetch,
	finishAccount,
	finishInstallation,
	finishLink,
	installationInput,
	installationStatus,
	installedIn,
	linkedBy,
	queueEvent,
	saveConversations,
	saveCredentials,
	startAccount,
	startInstallation,
	unlinkAccount,
	type WorkSource,
	webhookEvent,
	webhookUrl,
} from "@orqestra/integrations";
import { sources as served } from "@orqestra/integrations/sources";
import { Elysia, status } from "elysia";
import { z } from "zod";
import { adminOnly, signedInOnly } from "./admin.ts";
import type { SignedIn } from "./app.ts";
import { saved } from "./saved.ts";

// Each WorkSource Orqestra serves (ADR 0018, 0020) at /api/<kind>: Orqestra's app, an Integration Installation an Admin installs in
// /console/<kind> by OAuth or by entering the credentials the Integration gave them, its secrets and tokens only going in; and each
// User's Integration Account, linked from the Connections page by authorizing as themselves or by opening the link the app sent them.

const notFound = { errors: { "": { code: "not_found" as const } } };

/** Refuses a route of another kind of install than the source's. */
const only = (applies: boolean) =>
	applies ? undefined : status(404, notFound);

export const integrationRoutes = (
	signedIn: SignedIn,
	{
		orqestraUrl,
		fetch,
		sources = served,
	}: { orqestraUrl: string; fetch?: Fetch; sources?: WorkSource[] },
) => {
	// a guard of its own for each: one derive of an instance also guards the routes before it
	const ofKind = () =>
		new Elysia({ prefix: "/:kind" }).use(signedIn).derive(({ params }) => {
			const source = sources.find((s) => s.kind === params.kind);
			return source ? { source } : status(404, notFound);
		});
	return new Elysia()
		.use(
			new Elysia({ prefix: "/integrations" })
				.use(signedIn)
				.derive(signedInOnly)
				// every source, whether its app is installed, and the account the User linked in it: the Connections page's and the console's
				.get("/", ({ user }) =>
					Promise.all(
						sources.map(async (source) => ({
							kind: source.kind,
							name: source.name,
							install: source.install.mode,
							proof: source.proof.mode,
							workspace: await installedIn(source),
							account: await accountOf(source, user.id),
						})),
					),
				)
				// whom a private link the app sent links, for the User to confirm: opening it links nobody, since a mail's link scanner opens it first
				.get(
					"/link",
					({ query }) => {
						const sent = linkedBy(query.link);
						const source = sent && sources.find((s) => s.kind === sent.kind);
						return sent && source
							? { kind: sent.kind, integration: source.name, name: sent.name }
							: status(422, {
									errors: { link: { code: "link_invalid" as const } },
								});
					},
					{ query: z.object({ link: z.string() }) },
				)
				// a private link the app sent, confirmed by the User signed in
				.post(
					"/link",
					async ({ user, body }) => {
						const kind = await finishLink(user.id, body.link);
						return kind
							? { linked: kind }
							: status(422, {
									errors: { link: { code: "link_invalid" as const } },
								});
					},
					{ body: z.object({ link: z.string() }) },
				),
		)
		.use(
			ofKind()
				// the Integration sends both back here: a User linking their account, on to the Connections page; an Admin installing, on to the console
				.get("/callback", async ({ source, user, request, redirect }) => {
					const query = new URL(request.url).searchParams;
					if (accountState(source, query.get("state"))) {
						const error = user
							? await finishAccount(source, user.id, query, {
									orqestraUrl,
									fetch,
								})
							: "state_invalid";
						const to = new URLSearchParams(
							error ? { error } : { linked: source.kind },
						);
						return redirect(`/connections?${to}`, 302);
					}
					if (!user?.admin) return adminOnly({ user });
					const error = await finishInstallation(source, query, {
						orqestraUrl,
						fetch,
					});
					return redirect(
						error
							? `/console/${source.kind}?error=${error}`
							: `/console/${source.kind}`,
						302,
					);
				}),
		)
		.use(
			ofKind()
				.derive(signedInOnly)
				// whether the app is installed, and the account the User linked
				.get("/account", async ({ source, user }) => ({
					installed: !!(await installedIn(source)),
					account: await accountOf(source, user.id),
				}))
				// the URL to send the User to, to authorize as themselves; none for a source whose people prove themselves by a link
				.post("/account", async ({ source, user }) => {
					const url = await startAccount(source, user.id, orqestraUrl);
					return url ? { url } : status(404, notFound);
				})
				.delete("/account", async ({ source, user }) => {
					await unlinkAccount(source, user.id);
					return null;
				}),
		)
		.use(
			ofKind()
				.derive(adminOnly)
				.get(
					"/",
					async ({ source }) =>
						only(source.install.mode === "oauth") ?? {
							installation: await installationStatus(source),
							callbackUrl: callbackUrl(source, orqestraUrl),
							webhookUrl: webhookUrl(source, orqestraUrl),
						},
				)
				// once the credentials are saved, the URL to send the Admin to
				.post(
					"/",
					async ({ source, body }) =>
						only(source.install.mode === "oauth") ??
						saved(await startInstallation(source, body, orqestraUrl)),
					{ body: installationInput },
				)
				// a credentials install: the fields the Admin enters, a secret one only as whether it is set, and the workspace they are for
				.get(
					"/credentials",
					async ({ source }) =>
						only(source.install.mode === "credentials") ?? {
							name: source.name,
							sharedScopes: source.sharedScopes,
							...(await credentialsStatus(source)),
							callbackUrl:
								source.proof.mode === "oauth"
									? callbackUrl(source, orqestraUrl)
									: null,
							webhookUrl:
								source.ingress.mode === "webhook"
									? webhookUrl(source, orqestraUrl)
									: null,
						},
				)
				.put(
					"/credentials",
					async ({ source, body }) =>
						only(source.install.mode === "credentials") ??
						saved(await saveCredentials(source, body, { fetch })),
					{ body: credentialsInput },
				)
				// the Agent, repositories and opened scopes of the Conversations the Integration opens
				.put(
					"/conversations",
					async ({ source, body }) =>
						saved(await saveConversations(source, body)),
					{ body: conversationsInput },
				),
		);
};

// Each webhook source's webhook, signed with its webhook secret rather than signed in: it only queues the event for the worker, since
// Linear counts a delivery that takes over 5 seconds as failed
export const integrationWebhooks = (sources = served) =>
	new Elysia().post(
		"/:kind/webhook",
		async ({ params, request, status }) => {
			const source = sources.find((s) => s.kind === params.kind);
			const event =
				source &&
				(await webhookEvent(source, await request.text(), request.headers));
			if (event === undefined)
				return status(401, { errors: { signature: { code: "invalid" } } });
			if (event && source) await queueEvent(source, event);
			return status(200, null);
		},
		// the signature is over the raw body
		{ parse: "none" },
	);
