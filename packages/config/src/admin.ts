import { type Db, db, type Tx } from "@orqestra/db";
import {
	agent,
	documentParser,
	limits,
	mcpServer,
	sandboxProvider,
	searchProvider,
	skill,
	toolService,
} from "@orqestra/db/schema";
import { decryptSecret, sealSecret, secretReadable } from "@orqestra/db/secret";
import {
	deleteMcpServer,
	mcpServerAdmin,
	type OrqestraReach,
	revokeConnections,
} from "@orqestra/mcp";
import {
	availableTools,
	type DocumentParserTestResult,
	type SandboxTestResult,
	testDocumentParser,
	testSandboxProvider,
} from "@orqestra/tools";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import {
	agentDefinition,
	agentId,
	DEFAULT_LIMITS,
	definitionIssues,
	isMineruNet,
	mcpToolRef,
	modelRef,
	type OrqestraConfig,
	type SaveErrors,
	type SearchProviderId,
	type SearchToolName,
	searchProviders as searchProviderCatalog,
	searchProviderId,
	searchToolName,
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

const httpUrl = z.url({ protocol: /^https?$/ });

export const searchProviderInput = z.object({
	id: searchProviderId,
	// blank keeps the stored key
	apiKey: z.string().trim().optional(),
	// the official one, or a self-hosted service or reverse proxy
	baseUrl: httpUrl,
});
export const toolServiceInput = z.object({
	tool: searchToolName,
	provider: searchProviderId.nullable(),
});
export const documentParserInput = z.object({
	enabled: z.boolean(),
	// mineru.net, or a self-hosted MinerU
	url: httpUrl,
	// blank keeps the stored key
	apiKey: z.string().trim().optional(),
});
export const sandboxProviderInput = z.object({
	url: httpUrl,
	// blank keeps the stored token
	token: z.string().trim().optional(),
	// blank: orrery's default Platform Snapshot
	snapshot: z.string().trim(),
	cpu: z.number().positive(),
	/** Bytes. */
	memory: z.number().int().positive(),
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

// null keeps following the default one (the Catalog's, or the official one)
const customBaseUrl = (url: string, fallback: string) =>
	url.replace(/\/+$/, "") === fallback.replace(/\/+$/, "") ? null : url;

/** Saves a Search Provider: a blank key keeps the stored one, the default baseUrl is stored as null (it follows the default). */
async function saveKeyed(
	write: Deps["write"],
	table: typeof searchProvider,
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

/** Which Search Provider serves each Tool; null when none is picked. */
export async function servedBy(from: Db = db) {
	const served = await from.select().from(toolService);
	const by = (tool: SearchToolName) =>
		(served.find((s) => s.tool === tool)?.searchProviderId ??
			null) as SearchProviderId | null;
	return { search: by("search"), scrape: by("scrape") };
}

const searchProviders = ({ current, write }: Deps) => ({
	/** Configured Search Providers, which one serves each Tool, and the Tools that are available. */
	async list() {
		const [rows, served, loaded] = await Promise.all([
			db.select().from(searchProvider).orderBy(searchProvider.createdAt),
			servedBy(),
			current(),
		]);
		return {
			configured: rows.map((r) => ({
				id: r.id,
				keyReadable: secretReadable(r.apiKey),
				baseUrl: r.baseUrl,
			})),
			servedBy: served,
			/** Tools with a usable Search Provider. */
			available: availableTools(loaded).filter(
				(t): t is SearchToolName => searchToolName.safeParse(t).success,
			),
		};
	},

	async save(
		input: z.infer<typeof searchProviderInput>,
	): Promise<{ errors: SaveErrors }> {
		const official =
			searchProviderCatalog.find((p) => p.id === input.id)?.baseUrl ?? "";
		return saveKeyed(write, searchProvider, input, official);
	},

	/** Tools it served become unavailable until another is picked. */
	delete: (id: string) =>
		write((tx) => tx.delete(searchProvider).where(eq(searchProvider.id, id))),

	/** Picks the Search Provider for a Tool; null leaves it unavailable. */
	serve: (tool: SearchToolName, providerId: string | null) =>
		write((tx) =>
			tx
				.insert(toolService)
				.values({ tool, searchProviderId: providerId })
				.onConflictDoUpdate({
					target: toolService.tool,
					set: { searchProviderId: providerId },
				}),
		),
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

// Orrery is the only Sandbox Provider, so its one row has a fixed id
const ORRERY = "orrery";

const sandboxProviders = ({ write }: Deps) => ({
	/** The configured one, or null; the token only goes in. */
	async get() {
		const row = await db.query.sandboxProvider.findFirst();
		return row
			? {
					url: row.url,
					tokenReadable: secretReadable(row.token),
					snapshot: row.snapshot,
					cpu: row.cpu,
					memory: row.memory,
				}
			: null;
	},

	/** Once saved, also the connection test's result. */
	async save(
		input: z.infer<typeof sandboxProviderInput>,
	): Promise<{ errors: SaveErrors; test?: SandboxTestResult }> {
		const stored = await db.query.sandboxProvider.findFirst();
		const token = sealSecret(input.token, stored?.token);
		const plain = input.token || (stored && decryptSecret(stored.token));
		if (!token || !plain)
			return { errors: { token: { code: "token_required" } } };
		const values = {
			url: input.url,
			token,
			snapshot: input.snapshot || null,
			cpu: input.cpu,
			memory: input.memory,
		};
		await write((tx) =>
			tx
				.insert(sandboxProvider)
				.values({ id: ORRERY, ...values })
				.onConflictDoUpdate({ target: sandboxProvider.id, set: values }),
		);
		// saved either way, so the Admin can fix the address or token later
		return {
			errors: {},
			test: await testSandboxProvider({ url: input.url, token: plain }),
		};
	},

	/** Every Skill becomes unavailable; Sandboxes already in orrery are left there. */
	delete: () => write((tx) => tx.delete(sandboxProvider)),
});

// MinerU is the only Document Parser, so its one row has a fixed id
const MINERU = "mineru";

const documentParsers = ({ write }: Deps) => ({
	/** The configured one, or null; the key only goes in, `keyReadable` null when none is stored. */
	async get() {
		const row = await db.query.documentParser.findFirst();
		return row
			? {
					enabled: row.enabled,
					url: row.url,
					keyReadable: row.apiKey === null ? null : secretReadable(row.apiKey),
				}
			: null;
	},

	/** Once saved, also the connection test's result. The key is required for mineru.net, optional for a self-hosted MinerU. */
	async save(
		input: z.infer<typeof documentParserInput>,
	): Promise<{ errors: SaveErrors; test?: DocumentParserTestResult }> {
		const stored = await db.query.documentParser.findFirst();
		const apiKey =
			sealSecret(input.apiKey, stored?.apiKey ?? undefined) ?? null;
		const plain = input.apiKey || (apiKey && decryptSecret(apiKey)) || "";
		if (isMineruNet(input.url) && !plain)
			return { errors: { apiKey: { code: "api_key_required" } } };
		const values = { enabled: input.enabled, url: input.url, apiKey };
		await write((tx) =>
			tx
				.insert(documentParser)
				.values({ id: MINERU, ...values })
				.onConflictDoUpdate({ target: documentParser.id, set: values }),
		);
		// saved either way, so the Admin can fix the address or key later
		return {
			errors: {},
			test: await testDocumentParser({ baseUrl: input.url, apiKey: plain }),
		};
	},

	/** Parse becomes unavailable; parses already cached stay with their Attachments. */
	delete: () => write((tx) => tx.delete(documentParser)),
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
	searchProviders: searchProviders(deps),
	mcpServers: mcpServers(deps),
	sandboxProvider: sandboxProviders(deps),
	documentParser: documentParsers(deps),
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
