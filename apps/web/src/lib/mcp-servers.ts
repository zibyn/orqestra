import { mcpServerId } from "@orqestra/config";
import {
	config,
	mcpServerEnabledInput,
	mcpServerInput,
} from "@orqestra/config/live";
import { createServerFn } from "@tanstack/react-start";
import { requireAdmin } from "#/lib/session";

// MCP Servers, edited by Admins in /console/providers. Header values only go in.

export const getMcpServers = createServerFn().handler(async () => {
	await requireAdmin();
	return config.mcpServers.list();
});

/** Field errors by name (`id`, `headers`); empty when it was saved, then with the connection test's result. */
export const saveMcpServer = createServerFn({ method: "POST" })
	.validator(mcpServerInput)
	.handler(async ({ data }) => {
		await requireAdmin();
		return config.mcpServers.save(data);
	});

export const setMcpServerEnabled = createServerFn({ method: "POST" })
	.validator(mcpServerEnabledInput)
	.handler(async ({ data }) => {
		await requireAdmin();
		await config.mcpServers.setEnabled(data.id, data.enabled);
	});

/** Also removes it from every Agent Definition. */
export const deleteMcpServer = createServerFn({ method: "POST" })
	.validator(mcpServerId)
	.handler(async ({ data }) => {
		await requireAdmin();
		await config.mcpServers.delete(data);
	});
