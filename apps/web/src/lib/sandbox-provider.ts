import { config, sandboxProviderInput } from "@orqestra/config/live";
import { createServerFn } from "@tanstack/react-start";
import { requireAdmin } from "#/lib/session";

// The Sandbox Provider (orrery), edited by Admins in /console/sandbox. The API Token only goes in.

export const getSandboxProvider = createServerFn().handler(async () => {
	await requireAdmin();
	return config.sandboxProvider.get();
});

/** Field errors by name (`token`); empty when it was saved, then with the connection test's result. */
export const saveSandboxProvider = createServerFn({ method: "POST" })
	.validator(sandboxProviderInput)
	.handler(async ({ data }) => {
		await requireAdmin();
		return config.sandboxProvider.save(data);
	});

/** Every Skill becomes unavailable. */
export const deleteSandboxProvider = createServerFn({ method: "POST" }).handler(
	async () => {
		await requireAdmin();
		await config.sandboxProvider.delete();
	},
);
