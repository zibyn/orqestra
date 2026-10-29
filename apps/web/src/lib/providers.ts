import {
	config,
	modelEnabledInput,
	providerInput,
	providerTestInput,
} from "@orqestra/config/live";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireAdmin } from "#/lib/session";

// Providers and enabled Models, edited by Admins in /console/providers. API keys only go in, never back out.

export const getProviders = createServerFn().handler(async () => {
	await requireAdmin();
	return config.providers.list();
});

/** Field errors by name (`id`, `apiKey`); empty when it was saved. */
export const saveProvider = createServerFn({ method: "POST" })
	.validator(providerInput)
	.handler(async ({ data }) => {
		await requireAdmin();
		return config.providers.save(data);
	});

/** Also deletes its key and enabled Models; Runs already using it finish. */
export const deleteProvider = createServerFn({ method: "POST" })
	.validator(z.string())
	.handler(async ({ data }) => {
		await requireAdmin();
		await config.providers.delete(data);
	});

export const setModelEnabled = createServerFn({ method: "POST" })
	.validator(modelEnabledInput)
	.handler(async ({ data }) => {
		await requireAdmin();
		await config.providers.setModelEnabled(data);
	});

/** Tries the form's unsaved values on one Model; null when it worked, else the error. */
export const testProvider = createServerFn({ method: "POST" })
	.validator(providerTestInput)
	.handler(async ({ data }) => {
		await requireAdmin();
		return config.providers.test(data);
	});
