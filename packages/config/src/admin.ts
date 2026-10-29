import { db, type Tx } from "@orqestra/db";
import {
	agent,
	enabledModel,
	mcpServer,
	provider,
	searchProvider,
	toolService,
} from "@orqestra/db/schema";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import {
	agentDefinition,
	agentId,
	catalogProviders,
	definitionIssues,
	mcpServerId,
	mcpToolRef,
	modelRef,
	type OrqestraConfig,
	type SaveErrors,
	searchProviderId,
	searchProviders,
	type ToolName,
	type ToolRef,
	testConnection,
	toolName,
} from "./index.ts";
import { type McpTestResult, testMcpServer } from "./mcp.ts";
import { decryptSecret, sealSecret, secretReadable } from "./secret.ts";

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
export const searchProviderInput = z.object({
	id: searchProviderId,
	// blank keeps the stored key
	apiKey: z.string().trim().optional(),
	// the official one, or a self-hosted service or reverse proxy
	baseUrl: httpUrl,
});
export const toolServiceInput = z.object({
	tool: toolName,
	provider: searchProviderId.nullable(),
});
export const mcpServerInput = z.object({
	// checked in save, so a bad id lands on the id field
	id: z.string(),
	create: z.boolean(),
	name: z.string().trim().min(1),
	url: httpUrl,
	enabled: z.boolean(),
	headers: z.array(
		z.object({
			name: z.string().trim().min(1),
			// blank keeps the stored value of the header with this name
			value: z.string().trim().optional(),
		}),
	),
});
export const mcpServerEnabledInput = z.object({
	id: mcpServerId,
	enabled: z.boolean(),
});
export const agentInput = z.object({
	id: agentId,
	create: z.boolean(),
	definition: z.unknown(),
});

// null keeps following the default one (the Catalog's, or the official one)
const customBaseUrl = (url: string, fallback: string) =>
	url.replace(/\/+$/, "") === fallback.replace(/\/+$/, "") ? null : url;

// RFC 7230 token
const headerName = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/** Built-in Tools with a usable Search Provider, then `mcp:<id>` of available MCP Servers. */
const availableTools = (config: OrqestraConfig): ToolRef[] => [
	...toolName.options.filter((t) => config.tools[t]),
	...Object.keys(config.mcpServers).map(mcpToolRef),
];

async function catalogProvider(id: string) {
	const found = (await catalogProviders()).find((p) => p.id === id);
	if (!found) throw new Error(`"${id}" is not a Provider in the Catalog`);
	return found;
}

const storedProvider = (id: string) =>
	db.query.provider.findFirst({ where: eq(provider.id, id) });

const providers = ({ write }: Deps) => ({
	/** The Catalog, and the Providers configured from it with their enabled Models. */
	async list() {
		const [catalog, rows, enabled] = await Promise.all([
			catalogProviders(),
			db.select().from(provider).orderBy(provider.createdAt),
			db.select().from(enabledModel),
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
				enabledModels: enabled
					.filter((e) => e.providerId === r.id)
					.map((e) => e.modelId),
			})),
		};
	},

	async save(
		input: z.infer<typeof providerInput>,
	): Promise<{ errors: SaveErrors }> {
		const catalog = (await catalogProviders()).find((p) => p.id === input.id);
		if (!catalog) return { errors: { id: { code: "not_in_catalog" } } };
		const baseUrl = customBaseUrl(input.baseUrl, catalog.baseUrl);
		const stored = await storedProvider(input.id);
		const apiKey = sealSecret(input.apiKey, stored?.apiKey);
		if (!apiKey) return { errors: { apiKey: { code: "api_key_required" } } };
		await write((tx) =>
			tx
				.insert(provider)
				.values({ id: input.id, apiKey, baseUrl })
				.onConflictDoUpdate({ target: provider.id, set: { apiKey, baseUrl } }),
		);
		return { errors: {} };
	},

	/** Also deletes its key and enabled Models; Runs already using it finish. */
	delete: (id: string) =>
		write((tx) => tx.delete(provider).where(eq(provider.id, id))),

	/** Tries unsaved values on one Model; null when it worked, else the error. */
	async test(input: z.infer<typeof providerTestInput>) {
		const model = (await catalogProvider(input.id)).models.find(
			(m) => m.id === input.modelId,
		);
		if (!model) throw new Error(`"${input.modelId}" is not in the Catalog`);
		const stored = await storedProvider(input.id);
		const apiKey =
			input.apiKey || (stored && decryptSecret(stored.apiKey)) || undefined;
		if (!apiKey) return "An API key is required";
		return (await testConnection(model, apiKey, input.baseUrl)) ?? null;
	},

	async setModelEnabled(input: z.infer<typeof modelEnabledInput>) {
		if (input.enabled) {
			const catalog = await catalogProvider(input.providerId);
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
});

const searchProvidersOf = ({ current, write }: Deps) => ({
	/** Configured Search Providers, which one serves each Tool, and the Tools that are available. */
	async list() {
		const [rows, served, loaded] = await Promise.all([
			db.select().from(searchProvider).orderBy(searchProvider.createdAt),
			db.select().from(toolService),
			current(),
		]);
		const servedBy = (tool: ToolName) =>
			served.find((s) => s.tool === tool)?.searchProviderId ?? null;
		return {
			configured: rows.map((r) => ({
				id: r.id,
				keyReadable: secretReadable(r.apiKey),
				baseUrl: r.baseUrl,
			})),
			servedBy: { search: servedBy("search"), scrape: servedBy("scrape") },
			/** Tools with a usable Search Provider. */
			available: availableTools(loaded).filter(
				(t): t is ToolName => toolName.safeParse(t).success,
			),
		};
	},

	async save(
		input: z.infer<typeof searchProviderInput>,
	): Promise<{ errors: SaveErrors }> {
		const official =
			searchProviders.find((p) => p.id === input.id)?.baseUrl ?? "";
		const baseUrl = customBaseUrl(input.baseUrl, official);
		const stored = await db.query.searchProvider.findFirst({
			where: eq(searchProvider.id, input.id),
		});
		const apiKey = sealSecret(input.apiKey, stored?.apiKey);
		if (!apiKey) return { errors: { apiKey: { code: "api_key_required" } } };
		await write((tx) =>
			tx
				.insert(searchProvider)
				.values({ id: input.id, apiKey, baseUrl })
				.onConflictDoUpdate({
					target: searchProvider.id,
					set: { apiKey, baseUrl },
				}),
		);
		return { errors: {} };
	},

	/** Tools it served become unavailable until another is picked. */
	delete: (id: string) =>
		write((tx) => tx.delete(searchProvider).where(eq(searchProvider.id, id))),

	/** Picks the Search Provider for a Tool; null leaves it unavailable. */
	serve: (tool: ToolName, providerId: string | null) =>
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

const mcpServers = ({ write }: Deps) => ({
	async list() {
		const rows = await db.select().from(mcpServer).orderBy(mcpServer.createdAt);
		return rows.map((r) => ({
			id: r.id,
			name: r.name,
			url: r.url,
			enabled: r.enabled,
			headers: r.headers.map((h) => ({
				name: h.name,
				readable: secretReadable(h.value),
			})),
		}));
	},

	/** Once saved, also the connection test's result. */
	async save(
		input: z.infer<typeof mcpServerInput>,
	): Promise<{ errors: SaveErrors; test?: McpTestResult }> {
		if (!mcpServerId.safeParse(input.id).success)
			return { errors: { id: { code: "id_invalid" } } };
		const stored = await db.query.mcpServer.findFirst({
			where: eq(mcpServer.id, input.id),
		});
		if (input.create && stored) return { errors: { id: { code: "id_taken" } } };
		if (!input.create && !stored)
			return { errors: { id: { code: "not_found" } } };
		const headers = [];
		const plain: Record<string, string> = {};
		const seen = new Set<string>();
		for (const h of input.headers) {
			const header = h.name;
			if (!headerName.test(header))
				return { errors: { headers: { code: "header_invalid", header } } };
			if (seen.has(header.toLowerCase()))
				return { errors: { headers: { code: "header_twice", header } } };
			seen.add(header.toLowerCase());
			const kept = h.value
				? undefined
				: stored?.headers.find((s) => s.name === header)?.value;
			const value = h.value || (kept && decryptSecret(kept));
			if (!value)
				return {
					errors: { headers: { code: "header_value_missing", header } },
				};
			headers.push({
				name: header,
				value: sealSecret(h.value, kept) as string,
			});
			plain[header] = value;
		}
		const values = {
			name: input.name,
			url: input.url,
			enabled: input.enabled,
			headers,
		};
		await write((tx) =>
			tx
				.insert(mcpServer)
				.values({ id: input.id, ...values })
				.onConflictDoUpdate({ target: mcpServer.id, set: values }),
		);
		// saved either way, so the Admin can fix the URL or headers later
		return {
			errors: {},
			test: await testMcpServer({ url: input.url, headers: plain }),
		};
	},

	async setEnabled(id: string, enabled: boolean) {
		const updated = await write((tx) =>
			tx
				.update(mcpServer)
				.set({ enabled })
				.where(eq(mcpServer.id, id))
				.returning({ id: mcpServer.id }),
		);
		if (!updated.length) throw new Error("MCP Server not found");
	},

	/** Also removes it from every Agent Definition. */
	delete: (id: string) =>
		write(async (tx) => {
			const ref = mcpToolRef(id);
			await tx.delete(mcpServer).where(eq(mcpServer.id, id));
			await tx.execute(
				sql`update ${agent} set definition = jsonb_set(definition, '{tools}', (definition->'tools') - ${ref}::text) where definition->'tools' @> ${JSON.stringify([ref])}::jsonb`,
			);
		}),
});

const isDefault = (stored: { definition: unknown } | undefined) =>
	!!stored && agentDefinition.parse(stored.definition).default;

const agents = ({ current, write }: Deps) => ({
	/** Agent Definitions as stored and as resolved, with what an Admin can pick from when editing one. */
	async list() {
		const [rows, loaded, servers] = await Promise.all([
			db.select().from(agent).orderBy(agent.createdAt),
			current(),
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
			availableTools: availableTools(loaded),
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
	searchProviders: searchProvidersOf(deps),
	mcpServers: mcpServers(deps),
	agents: agents(deps),
});
