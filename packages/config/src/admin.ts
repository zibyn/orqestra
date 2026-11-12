import { db, type Tx } from "@orqestra/db";
import {
	agent,
	enabledModel,
	limits,
	mcpServer,
	modelPrice,
	provider,
	skill,
} from "@orqestra/db/schema";
import { decryptSecret, sealSecret, secretReadable } from "@orqestra/db/secret";
import {
	deleteMcpServer,
	mcpServerAdmin,
	type OrqestraReach,
	revokeConnections,
} from "@orqestra/mcp";
import { availableTools } from "@orqestra/tools";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import {
	agentDefinition,
	agentId,
	catalogProviders,
	DEFAULT_LIMITS,
	definitionIssues,
	mcpToolRef,
	modelRef,
	type OrqestraConfig,
	priceInForce,
	pricesByModel,
	type SaveErrors,
	spendingLimit,
	testConnection,
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

const httpUrl = z.url({ protocol: /^https?$/ });

export const providerInput = z.object({
	id: z.string().min(1),
	// blank keeps the stored key
	apiKey: z.string().trim().optional(),
	// the Catalog's baseUrl, or another endpoint for the same API
	baseUrl: httpUrl,
});
export const providerTestInput = providerInput.extend({ modelId: z.string() });
export const modelEnabledInput = z.object({
	providerId: z.string(),
	modelId: z.string(),
	enabled: z.boolean(),
});
const price = z.number().nonnegative();
export const modelPriceInput = z.object({
	providerId: z.string(),
	modelId: z.string(),
	// dollars per million tokens; null goes back to the Catalog's
	cost: z
		.object({
			input: price,
			output: price,
			cacheRead: price,
			cacheWrite: price,
		})
		.nullable(),
});
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

// null keeps following the Catalog's
const customBaseUrl = (url: string, fallback: string) =>
	url.replace(/\/+$/, "") === fallback.replace(/\/+$/, "") ? null : url;

const catalogProvider = async (id: string) =>
	(await catalogProviders()).find((p) => p.id === id);
const notInCatalog = (id: string): never => {
	throw new Error(`"${id}" is not a Provider in the Catalog`);
};

const storedProvider = (id: string) =>
	db.query.provider.findFirst({ where: eq(provider.id, id) });

/** Saves a Provider: a blank key keeps the stored one, the default baseUrl is stored as null (it follows the default). */
async function saveKeyed(
	write: Deps["write"],
	table: typeof provider,
	input: { id: string; apiKey?: string; baseUrl: string },
	defaultBaseUrl: string,
): Promise<{ errors: SaveErrors }> {
	const baseUrl = customBaseUrl(input.baseUrl, defaultBaseUrl);
	const [stored] = await db
		.select({ apiKey: table.apiKey })
		.from(table)
		.where(eq(table.id, input.id));
	const apiKey = sealSecret(input.apiKey, stored?.apiKey);
	if (!apiKey) return { errors: { apiKey: { code: "api_key_required" } } };
	await write((tx) =>
		tx
			.insert(table)
			.values({ id: input.id, apiKey, baseUrl })
			.onConflictDoUpdate({ target: table.id, set: { apiKey, baseUrl } }),
	);
	return { errors: {} };
}

const providers = ({ write }: Deps) => ({
	/** The Catalog, and the Providers configured from it with their enabled Models. */
	async list() {
		const [catalog, rows, enabled, prices] = await Promise.all([
			catalogProviders(),
			db.select().from(provider).orderBy(provider.createdAt),
			db.select().from(enabledModel),
			db.select().from(modelPrice).then(pricesByModel),
		]);
		return {
			catalog: catalog.map((p) => ({
				id: p.id,
				name: p.name,
				baseUrl: p.baseUrl,
				models: p.models.map((m) => ({ id: m.id, name: m.name })),
			})),
			configured: rows.map((r) => ({
				id: r.id,
				baseUrl: r.baseUrl,
				keyReadable: secretReadable(r.apiKey),
				// each with the price in force: the Admin's, else the Catalog's (none when the Catalog dropped the Model)
				enabledModels: enabled
					.filter((e) => e.providerId === r.id)
					.map((e) => ({
						id: e.modelId,
						...priceInForce(
							prices,
							modelRef({ provider: r.id, id: e.modelId }),
							catalog
								.find((p) => p.id === r.id)
								?.models.find((m) => m.id === e.modelId)?.cost,
						),
					})),
			})),
		};
	},

	async save(
		input: z.infer<typeof providerInput>,
	): Promise<{ errors: SaveErrors }> {
		const catalog = await catalogProvider(input.id);
		if (!catalog) return { errors: { id: { code: "not_in_catalog" } } };
		return saveKeyed(write, provider, input, catalog.baseUrl);
	},

	/** Also deletes its key and enabled Models; Runs already using it finish. */
	delete: (id: string) =>
		write((tx) => tx.delete(provider).where(eq(provider.id, id))),

	/** Tries unsaved values on one Model; null when it worked, else the error. */
	async test(input: z.infer<typeof providerTestInput>) {
		const catalog = (await catalogProvider(input.id)) ?? notInCatalog(input.id);
		const model = catalog.models.find((m) => m.id === input.modelId);
		if (!model) throw new Error(`"${input.modelId}" is not in the Catalog`);
		const stored = await storedProvider(input.id);
		const apiKey =
			input.apiKey || (stored && decryptSecret(stored.apiKey)) || undefined;
		if (!apiKey) return "An API key is required";
		return (await testConnection(model, apiKey, input.baseUrl)) ?? null;
	},

	async setModelEnabled(input: z.infer<typeof modelEnabledInput>) {
		if (input.enabled) {
			const catalog =
				(await catalogProvider(input.providerId)) ??
				notInCatalog(input.providerId);
			if (!catalog.models.some((m) => m.id === input.modelId))
				throw new Error(`"${input.modelId}" is not in the Catalog`);
		}
		await write((tx) =>
			input.enabled
				? tx
						.insert(enabledModel)
						.values({ providerId: input.providerId, modelId: input.modelId })
						.onConflictDoNothing()
				: tx
						.delete(enabledModel)
						.where(
							and(
								eq(enabledModel.providerId, input.providerId),
								eq(enabledModel.modelId, input.modelId),
							),
						),
		);
	},

	/** Sets an enabled Model's price, or clears it with a null `cost`; Runs that start afterwards are costed at it. */
	async setModelPrice({
		providerId,
		modelId,
		cost,
	}: z.infer<typeof modelPriceInput>): Promise<{ errors: SaveErrors }> {
		const key = and(
			eq(enabledModel.providerId, providerId),
			eq(enabledModel.modelId, modelId),
		);
		const [enabled] = await db.select().from(enabledModel).where(key);
		if (!enabled) return { errors: { modelId: { code: "model_not_enabled" } } };
		await write((tx) =>
			cost
				? tx
						.insert(modelPrice)
						.values({ providerId, modelId, ...cost })
						.onConflictDoUpdate({
							target: [modelPrice.providerId, modelPrice.modelId],
							set: cost,
						})
				: tx
						.delete(modelPrice)
						.where(
							and(
								eq(modelPrice.providerId, providerId),
								eq(modelPrice.modelId, modelId),
							),
						),
		);
		return { errors: {} };
	},
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
	providers: providers(deps),
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
