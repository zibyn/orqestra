import {
	agentDefinition,
	agentId,
	definitionIssues,
	modelRef,
	toolName,
} from "@orqestra/config";
import { db, eq, sql } from "@orqestra/db";
import { agent, mcpServer } from "@orqestra/db/schema";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { config, reloadConfig } from "#/lib/config";
import { requireAdmin } from "#/lib/session";

// Agent Definitions, edited by Admins in /console/agents.

export const listAgents = createServerFn().handler(async () => {
	await requireAdmin();
	const [rows, loaded, servers] = await Promise.all([
		db.select().from(agent).orderBy(agent.createdAt),
		config.get(),
		db
			.select({ id: mcpServer.id, name: mcpServer.name })
			.from(mcpServer)
			.orderBy(mcpServer.createdAt),
	]);
	return {
		agents: rows.map((r) => {
			const resolved = loaded.agents.find((a) => a.id === r.id);
			return {
				id: r.id,
				definition: agentDefinition.parse(r.definition),
				models: resolved?.models ?? [],
				defaultModel: resolved?.defaultModel ?? "",
				unavailableModels: resolved?.unavailableModels ?? [],
			};
		}),
		enabledModels: loaded.models.map((m) => ({
			ref: modelRef(m),
			name: m.name,
		})),
		/** Every configured MCP Server, enabled or not. */
		mcpServers: servers,
		/** Tools with a usable Search Provider, and `mcp:<id>` of available MCP Servers. */
		availableTools: [
			...toolName.options.filter((t) => loaded.tools[t]),
			...Object.keys(loaded.mcpServers).map((id) => `mcp:${id}` as const),
		],
	};
});

/** Field errors by path (`name`, `thinking.default`, …); empty when it was saved. */
export const saveAgent = createServerFn({ method: "POST" })
	.validator(
		z.object({ id: agentId, create: z.boolean(), definition: z.unknown() }),
	)
	.handler(async ({ data }): Promise<{ errors: Record<string, string> }> => {
		await requireAdmin();
		const parsed = agentDefinition.safeParse(data.definition);
		if (!parsed.success)
			return {
				errors: Object.fromEntries(
					parsed.error.issues.map((i) => [i.path.join("."), i.message]),
				),
			};
		const def = parsed.data;
		const errors = Object.fromEntries(
			definitionIssues(def).map((i) => [i.field, i.message]),
		);
		const stored = await db.query.agent.findFirst({
			where: eq(agent.id, data.id),
		});
		if (data.create && stored)
			errors.id = "An Agent with this id already exists";
		if (!data.create && !stored) throw new Error("Agent not found");
		if (
			stored &&
			agentDefinition.parse(stored.definition).default &&
			!def.default
		)
			errors.default = "Make another Agent the default instead";
		if (Object.keys(errors).length) return { errors };

		await db.transaction(async (tx) => {
			// exactly one default: this one takes over
			if (def.default)
				await tx.execute(
					sql`update ${agent} set definition = definition || '{"default": false}'::jsonb where ${agent.id} <> ${data.id}`,
				);
			await tx
				.insert(agent)
				.values({ id: data.id, definition: def })
				.onConflictDoUpdate({ target: agent.id, set: { definition: def } });
		});
		await reloadConfig();
		return { errors: {} };
	});

/** Its Conversations become read-only; Runs already using it finish. */
export const deleteAgent = createServerFn({ method: "POST" })
	.validator(agentId)
	.handler(async ({ data }) => {
		await requireAdmin();
		const stored = await db.query.agent.findFirst({
			where: eq(agent.id, data),
		});
		if (stored && agentDefinition.parse(stored.definition).default)
			throw new Error("The default Agent cannot be deleted");
		await db.delete(agent).where(eq(agent.id, data));
		await reloadConfig();
	});
