import { db, type Tx } from "@orqestra/db";
import { agent, limits, mcpServer, skill } from "@orqestra/db/schema";
import {
	deleteMcpServer,
	mcpServerAdmin,
	type OrqestraReach,
	revokeConnections,
} from "@orqestra/mcp";
import { availableTools } from "@orqestra/tools";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import {
	agentDefinition,
	agentId,
	DEFAULT_LIMITS,
	definitionIssues,
	mcpToolRef,
	modelRef,
	type OrqestraConfig,
	type SaveErrors,
	spendingLimit,
	timeZone,
	turnSkills,
} from "./index.ts";

// What Admins edit in /console, by GLOSSARY entity: inputs, rules across fields and entities, and the management views.
// Secrets only go in; a view tells whether they can still be decrypted.

type Deps = {
	current: () => Promise<OrqestraConfig>;
	/** Runs `fn` in a transaction, then tells every process to reload. */
	write: <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>;
};

const count = z.number().int().positive();
export const limitsInput = z.object({
	maxScheduledTasksPerUser: count,
	/** Seconds. */
	minFiringInterval: count,
	timerRingsPerUserMessage: count,
	unattendedMaxSteps: count,
	/** Seconds. */
	unattendedMaxDuration: count,
	maxSubagentDepth: z.number().int().min(1).max(3),
	/** Every User's, unless the User has their own. */
	spendingLimit,
	/** Where a calendar month of Spending Limits begins and ends. */
	resetTimeZone: timeZone,
	/** Seconds, from a minute to 30 days. */
	backgroundCallMaxDuration: z
		.number()
		.int()
		.min(60)
		.max(30 * 24 * 60 * 60),
});
export const agentInput = z.object({
	id: agentId,
	create: z.boolean(),
	definition: z.unknown(),
});

const mcpServers = (deps: Deps) => ({
	...mcpServerAdmin(deps),

	/** Also removes it from every Agent Definition, and ends every Connection to it, revoked in the background once committed. */
	async delete(id: string, { fetch }: Pick<OrqestraReach, "fetch"> = {}) {
		const cleared = await deps.write(async (tx) => {
			const ref = mcpToolRef(id);
			const cleared = await deleteMcpServer(tx, id);
			await tx.execute(
				sql`update ${agent} set definition = jsonb_set(definition, '{tools}', (definition->'tools') - ${ref}::text) where definition->'tools' @> ${JSON.stringify([ref])}::jsonb`,
			);
			return cleared;
		});
		if (cleared.length) void revokeConnections(cleared, { fetch });
	},
});

// one row, with a fixed id
const limitsOf = ({ write }: Deps) => ({
	/** As saved, or the defaults. */
	async get() {
		const row = await db.query.limits.findFirst();
		if (!row) return DEFAULT_LIMITS;
		const { id: _, ...saved } = row;
		return saved;
	},
	/** The next Run reads them. */
	async save(
		input: z.infer<typeof limitsInput>,
	): Promise<{ errors: SaveErrors }> {
		await write((tx) =>
			tx
				.insert(limits)
				.values({ id: 1, ...input })
				.onConflictDoUpdate({ target: limits.id, set: input }),
		);
		return { errors: {} };
	},
});

const isDefault = (stored: { definition: unknown } | undefined) =>
	!!stored && agentDefinition.parse(stored.definition).default;

const agents = ({ current, write }: Deps) => ({
	/** Agent Definitions as stored and as resolved, with what an Admin can pick from when editing one. */
	async list() {
		const [rows, loaded, servers, skills] = await Promise.all([
			db.select().from(agent).orderBy(agent.createdAt),
			current(),
			db
				.select({ id: mcpServer.id, name: mcpServer.name })
				.from(mcpServer)
				.orderBy(mcpServer.createdAt),
			db.select({ name: skill.name }).from(skill).orderBy(skill.name),
		]);
		const skillNames = skills.map((s) => s.name);
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
			/** Built-in Tools with a usable Search Provider or Document Parser, and `mcp:<id>` of available MCP Servers. */
			availableTools: availableTools(loaded),
			/** Every Skill's name, enabled or not. */
			skills: skillNames,
			/** Skills a Run can use: enabled, with a Sandbox Provider configured. */
			availableSkills: turnSkills(loaded, { skills: skillNames }).map(
				(s) => s.name,
			),
		};
	},

	async save(
		input: z.infer<typeof agentInput>,
	): Promise<{ errors: SaveErrors }> {
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
		const errors: SaveErrors = Object.fromEntries(
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
		const stored = await db.query.agent.findFirst({ where: eq(agent.id, id) });
		if (isDefault(stored))
			throw new Error("The default Agent cannot be deleted");
		await write((tx) => tx.delete(agent).where(eq(agent.id, id)));
	},
});

export const admin = (deps: Deps) => ({
	mcpServers: mcpServers(deps),
	limits: limitsOf(deps),
	agents: agents(deps),
});

/** Removes a deleted Skill from every Agent Definition. */
export const forgetSkill = ({ write }: Pick<Deps, "write">, name: string) =>
	write((tx) =>
		tx.execute(
			sql`update ${agent} set definition = jsonb_set(definition, '{skills}', (definition->'skills') - ${name}::text) where definition->'skills' @> ${JSON.stringify([name])}::jsonb`,
		),
	);
