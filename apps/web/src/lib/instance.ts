import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { z } from "zod";
import {
	auth,
	getAllowMemberPassword,
	isSetupCompleted,
	oidc,
	passwordPolicy,
	setAllowMemberPassword,
	setupInstance,
} from "#/lib/auth";
import { canUsePassword } from "#/lib/identity";
import { requireAdmin } from "#/lib/session";

// Session plus whether Instance Setup is still pending; checked on every navigation by the root route.
export const getUserAndSetupState = createServerFn().handler(async () => {
	const session = await auth.api.getSession({ headers: getRequestHeaders() });
	return {
		needsSetup: !(await isSetupCompleted()),
		user: session?.user ?? null,
	};
});

export const runSetup = createServerFn({ method: "POST" })
	.validator(z.object({ email: z.email(), password: z.string().min(8) }))
	.handler(async ({ data }) => {
		if (!(await setupInstance(data)))
			throw new Error("Instance Setup has already been completed");
	});

export const getLoginOptions = createServerFn().handler(async () => ({
	oidcConfigured: oidc.configured,
	memberPassword: canUsePassword({ role: "user" }, await passwordPolicy()),
}));

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
