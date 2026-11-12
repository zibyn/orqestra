import type { Db } from "@orqestra/db";
import { live } from "@orqestra/db/live";
import { agent, mcpConnection, mcpServer, skill } from "@orqestra/db/schema";
import { decryptSecret } from "@orqestra/db/secret";
import { connectionStatus } from "@orqestra/mcp";
import { type ModelsLive, modelRef } from "@orqestra/models";
import type { SkillInfo, Skills } from "@orqestra/skills";
import { availableTools, type ToolServices } from "@orqestra/tools";
import { mcpToolRef, type ToolRef } from "@orqestra/tools/shared";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { type AgentsSnapshot, resolveAgents, turnSkills } from "./index.ts";
import {
	type AgentSaveError,
	agentDefinition,
	agentId,
	definitionIssues,
} from "./shared.ts";

/** NOTIFY channel, no payload: an Agent Definition changed, reload them. */
const AGENTS_CHANNEL = "agents_changed";

export const agentInput = z.object({
	id: agentId,
	create: z.boolean(),
	definition: z.unknown(),
});

const isDefault = (stored: { definition: unknown } | undefined) =>
	!!stored && agentDefinition.parse(stored.definition).default;

/**
 * The Agent Definitions: `current()` resolved against the Models, and what Admins edit in /console/agents.
 * The only writer of Agent Definitions. Callers check that the User is an Admin.
 */
export function createAgents(
	db: Db,
	{
		models,
		skills,
		available,
	}: {
		models: Pick<ModelsLive, "current">;
		/** Deleting a Skill goes through here, so it is forgotten after. */
		skills: Pick<Skills, "delete">;
		/** What a Run can use now, for the Agent form: the Tools', MCP Servers' and Skills' snapshots. */
		available: () => Promise<
			ToolServices & {
				skills: Record<string, SkillInfo>;
				sandboxProvider?: unknown;
			}
		>;
	},
) {
	const stored = live(db, {
		channel: AGENTS_CHANNEL,
		load: () => db.select().from(agent).orderBy(agent.createdAt),
	});
	// resolved again only when either snapshot was reloaded, the same object while neither is, as a snapshot is
	let last: { from: unknown[]; agents: Promise<AgentsSnapshot> } | undefined;
	const current = async () => {
		const from = await Promise.all([stored.current(), models.current()]);
		if (!last || from.some((f, i) => f !== last?.from[i])) {
			const [rows, m] = from;
			const next = Promise.resolve().then(() =>
				logWarnings(resolveAgents(rows, m)),
			);
			const previous = last?.agents;
			// as live does: a failed reload keeps the previous Agents
			last = {
				from,
				agents: previous
					? next.catch((error) => {
							console.error(`${AGENTS_CHANNEL}: reload failed`, error);
							return previous;
						})
					: next,
			};
		}
		return last.agents;
	};
	const { write } = stored;

	/** Removes a Tool or Skill from every Agent Definition that allows it. */
	const forget = (ref: { tool: ToolRef } | { skill: string }) => {
		const [field, value] =
			"tool" in ref ? ["tools", ref.tool] : ["skills", ref.skill];
		return write((tx) =>
			tx.execute(
				sql`update ${agent} set definition = jsonb_set(definition, ${`{${field}}`}::text[], (definition->${field}) - ${value}::text) where definition->${field} @> ${JSON.stringify([value])}::jsonb`,
			),
		);
	};

	return {
		current,
		write,
		close: () => stored.close(),
		forget,

		/** Deletes a Skill, then removes it from every Agent Definition. */
		async deleteSkill(name: string) {
			await skills.delete(name);
			await forget({ skill: name });
		},

		/** Agent Definitions as stored and as resolved, with what an Admin can pick from when editing one. */
		async list() {
			const [rows, loaded, enabled, usable, servers, skillRows] =
				await Promise.all([
					db.select().from(agent).orderBy(agent.createdAt),
					current(),
					models.current(),
					available(),
					db
						.select({ id: mcpServer.id, name: mcpServer.name })
						.from(mcpServer)
						.orderBy(mcpServer.createdAt),
					db.select({ name: skill.name }).from(skill).orderBy(skill.name),
				]);
			const skillNames = skillRows.map((s) => s.name);
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
				enabledModels: enabled.models.map((m) => ({
					ref: modelRef(m),
					name: m.name,
				})),
				/** Every configured MCP Server, enabled or not. */
				mcpServers: servers,
				/** Built-in Tools with a usable Search Provider or Document Parser, and `mcp:<id>` of available MCP Servers. */
				availableTools: availableTools(usable),
				/** Every Skill's name, enabled or not. */
				skills: skillNames,
				/** Skills a Run can use: enabled, with a Sandbox Provider configured. */
				availableSkills: turnSkills(usable, { skills: skillNames }).map(
					(s) => s.name,
				),
			};
		},

		async save(
			input: z.infer<typeof agentInput>,
		): Promise<{ errors: Record<string, AgentSaveError> }> {
			const parsed = agentDefinition.safeParse(input.definition);
			if (!parsed.success)
				return {
					errors: Object.fromEntries(
						parsed.error.issues.map((i) => [
							i.path.join("."),
							{ code: "invalid", detail: i.message },
						]),
					),
				};
			const def = parsed.data;
			const errors: Record<string, AgentSaveError> = Object.fromEntries(
				definitionIssues(def).map((i) => [i.field, i.error]),
			);
			const stored = await db.query.agent.findFirst({
				where: eq(agent.id, input.id),
			});
			if (input.create && stored) errors.id = { code: "id_taken" };
			if (!input.create && !stored) errors.id = { code: "not_found" };
			// exactly one default: another Agent must take over instead
			if (isDefault(stored) && !def.default)
				errors.default = { code: "default_required" };
			if (Object.keys(errors).length) return { errors };

			await write(async (tx) => {
				// exactly one default: this one takes over
				if (def.default)
					await tx.execute(
						sql`update ${agent} set definition = definition || '{"default": false}'::jsonb where ${agent.id} <> ${input.id}`,
					);
				await tx
					.insert(agent)
					.values({ id: input.id, definition: def })
					.onConflictDoUpdate({ target: agent.id, set: { definition: def } });
			});
			return { errors: {} };
		},

		/** Its Conversations become read-only; Runs already using it finish. The default Agent cannot be deleted, so one always exists. */
		async delete(id: string) {
			const stored = await db.query.agent.findFirst({
				where: eq(agent.id, id),
			});
			if (isDefault(stored))
				throw new Error("The default Agent cannot be deleted");
			await write((tx) => tx.delete(agent).where(eq(agent.id, id)));
		},

		/**
		 * What a User's Connections page lists: every per-User OAuth MCP Server, disabled ones included, with the User's Connection
		 * to it and the Agents the User can pick that use it. Never a token.
		 */
		async userConnections(userId: string) {
			const [rows, { agents }] = await Promise.all([
				db
					.select({
						id: mcpServer.id,
						name: mcpServer.name,
						enabled: mcpServer.enabled,
						status: mcpConnection.status,
						tokens: mcpConnection.tokens,
						connectedAt: mcpConnection.connectedAt,
					})
					.from(mcpServer)
					.leftJoin(
						mcpConnection,
						and(
							eq(mcpConnection.mcpServerId, mcpServer.id),
							eq(mcpConnection.userId, userId),
						),
					)
					.where(eq(mcpServer.auth, "oauth"))
					.orderBy(mcpServer.createdAt),
				current(),
			]);
			return rows.map(
				({ enabled, status, tokens, connectedAt, ...server }) => ({
					...server,
					disabled: !enabled,
					agents: agents
						.filter(
							(a) => a.pickable && a.tools.includes(mcpToolRef(server.id)),
						)
						.map((a) => a.name),
					status:
						tokens && status
							? connectionStatus({ status, tokens: decryptSecret(tokens) })
							: ("none" as const),
					connectedAt,
				}),
			);
		},
	};
}

export type Agents = ReturnType<typeof createAgents>;

const logWarnings = (snapshot: AgentsSnapshot) => {
	for (const a of snapshot.agents) {
		for (const ref of a.unavailableModels)
			console.warn(`Agent "${a.id}": Model "${ref}" is not available`);
		if (!a.models.length)
			console.warn(`Agent "${a.id}": no Model is available, so it is offline`);
	}
	return snapshot;
};
