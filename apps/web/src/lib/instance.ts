import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { z } from "zod";
import { env } from "#/env";
import {
	admins,
	auth,
	getAllowMemberPassword,
	oidc,
	setAllowMemberPassword,
} from "#/lib/auth";
import {
	bootstrapDefaultAdmin,
	canUsePassword,
	setupInstance,
} from "#/lib/identity";

let bootstrap: Promise<unknown> | undefined;

// Session plus whether Instance Setup is still pending; checked on every navigation by the root route.
export const getAppState = createServerFn().handler(async () => {
	// Env-var Instance Setup runs once per process, before the first page is served
	bootstrap ??= bootstrapDefaultAdmin(env, admins).catch((e) => {
		bootstrap = undefined;
		throw e;
	});
	await bootstrap;
	const session = await auth.api.getSession({ headers: getRequestHeaders() });
	return {
		needsSetup: !(await admins.hasAdmin()),
		user: session?.user ?? null,
	};
});

export const runSetup = createServerFn({ method: "POST" })
	.validator(z.object({ email: z.email(), password: z.string().min(8) }))
	.handler(async ({ data }) => {
		if (!(await setupInstance(admins, data)))
			throw new Error("Instance Setup has already been completed");
	});

export const getLoginOptions = createServerFn().handler(async () => ({
	oidcConfigured: oidc.configured,
	memberPassword: canUsePassword("user", {
		oidcConfigured: oidc.configured,
		allowMemberPassword: await getAllowMemberPassword(),
	}),
}));

async function requireAdmin() {
	const session = await auth.api.getSession({ headers: getRequestHeaders() });
	if (session?.user.role !== "admin") throw new Error("Forbidden");
}

export const getSettings = createServerFn().handler(async () => {
	await requireAdmin();
	return { allowMemberPassword: await getAllowMemberPassword(), oidc };
});

export const saveAllowMemberPassword = createServerFn({ method: "POST" })
	.validator(z.boolean())
	.handler(async ({ data }) => {
		await requireAdmin();
		await setAllowMemberPassword(data);
	});
