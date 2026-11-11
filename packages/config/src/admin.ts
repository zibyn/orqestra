import { db, type Tx } from "@orqestra/db";
import {
	agent,
	documentParser,
	enabledModel,
	limits,
	mcpServer,
	modelPrice,
	provider,
	sandboxProvider,
	searchProvider,
	skill,
	skillFile,
	skillVersion,
	toolService,
} from "@orqestra/db/schema";
import {
	availableTools,
	type DocumentParserTestResult,
	type McpTestResult,
	type SandboxTestResult,
	testDocumentParser,
	testMcpServer,
	testSandboxProvider,
} from "@orqestra/tools";
import { and, desc, eq, max, sql } from "drizzle-orm";
import { z } from "zod";
import {
	agentDefinition,
	agentId,
	catalogProviders,
	DEFAULT_LIMITS,
	definitionIssues,
	isMineruNet,
	mcpServerId,
	mcpToolRef,
	modelRef,
	type OrqestraConfig,
	type SaveErrors,
	type SearchProviderId,
	type SearchToolName,
	type SkillFile,
	searchProviders as searchProviderCatalog,
	searchProviderId,
	searchToolName,
	testConnection,
	turnSkills,
} from "./index.ts";
import { decryptSecret, sealSecret, secretReadable } from "./secret.ts";
import {
	checkSkill,
	parseSkillZip,
	type SkillFiles,
	skillName,
} from "./skill-zip.ts";

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
export const skillEnabledInput = z.object({
	name: z.string(),
	enabled: z.boolean(),
});
export const skillCurrentInput = z.object({
	name: z.string(),
	versionId: z.number().int(),
});
export const skillCreateInput = z.object({
	name: z.string(),
	description: z.string(),
});
export const skillEditInput = z.object({
	name: z.string(),
	base: z.number().int(),
	// without `text`: kept as it is in version `base`
	files: z.array(z.object({ path: z.string(), text: z.string().optional() })),
});
/** A Skill or version gone since the console loaded it; `field` is the input naming it. */
export class SkillNotFound extends Error {
	constructor(readonly field: "name" | "versionId" | "base") {
		super(field === "name" ? "Skill not found" : "Skill version not found");
	}
}

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

const catalogProvider = async (id: string) =>
	(await catalogProviders()).find((p) => p.id === id);
const notInCatalog = (id: string): never => {
	throw new Error(`"${id}" is not a Provider in the Catalog`);
};

const storedProvider = (id: string) =>
	db.query.provider.findFirst({ where: eq(provider.id, id) });

/** Saves a Provider or a Search Provider: a blank key keeps the stored one, the default baseUrl is stored as null (it follows the default). */
async function saveKeyed(
	write: Deps["write"],
	table: typeof provider | typeof searchProvider,
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
export async function servedBy() {
	const served = await db.select().from(toolService);
	const by = (tool: SearchToolName) =>
		(served.find((s) => s.tool === tool)?.searchProviderId ??
			null) as SearchProviderId | null;
	return { search: by("search"), scrape: by("scrape") };
}

const providers = ({ write }: Deps) => ({
	/** The Catalog, and the Providers configured from it with their enabled Models. */
	async list() {
		const [catalog, rows, enabled, prices] = await Promise.all([
			catalogProviders(),
			db.select().from(provider).orderBy(provider.createdAt),
			db.select().from(enabledModel),
			db.select().from(modelPrice),
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
					.map((e) => {
						const custom = prices.find(
							(p) => p.providerId === r.id && p.modelId === e.modelId,
						);
						if (custom) {
							const { providerId, modelId, ...cost } = custom;
							return { id: e.modelId, cost, source: "custom" as const };
						}
						const cost = catalog
							.find((p) => p.id === r.id)
							?.models.find((m) => m.id === e.modelId)?.cost;
						return { id: e.modelId, cost, source: "catalog" as const };
					}),
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

/** A version's files, paths relative to the Skill's folder; for Runs, by the `versionId` of `current().skills`. */
export const skillFiles = (versionId: number) =>
	db
		.select({ path: skillFile.path, content: skillFile.content })
		.from(skillFile)
		.where(eq(skillFile.versionId, versionId))
		.orderBy(skillFile.path);

/** Adds the Skill as its new current version, adding the Skill itself when it is new; one that exists needs `replace`. */
async function addVersion(
	tx: Tx,
	{ name, description, disableModelInvocation, files }: SkillFiles,
	replace: boolean,
): Promise<SaveErrors> {
	const inserted = await tx
		.insert(skill)
		.values({ name })
		.onConflictDoNothing()
		.returning({ name: skill.name });
	if (!inserted.length && !replace) return { name: { code: "skill_exists" } };
	// locks the Skill, so two saves cannot take the same number
	await tx
		.select({ name: skill.name })
		.from(skill)
		.where(eq(skill.name, name))
		.for("update");
	const [{ last }] = await tx
		.select({ last: max(skillVersion.number) })
		.from(skillVersion)
		.where(eq(skillVersion.skillName, name));
	const [version] = await tx
		.insert(skillVersion)
		.values({
			skillName: name,
			number: (last ?? 0) + 1,
			description,
			disableModelInvocation,
		})
		.returning({ id: skillVersion.id });
	await tx
		.insert(skillFile)
		.values(files.map((f) => ({ versionId: version.id, ...f })));
	await tx
		.update(skill)
		.set({ currentVersionId: version.id })
		.where(eq(skill.name, name));
	return {};
}

function asText(content: Uint8Array) {
	try {
		const text = new TextDecoder("utf-8", { fatal: true }).decode(content);
		return text.includes("\0") ? undefined : text;
	} catch {
		return undefined;
	}
}

const skills = ({ write }: Deps) => ({
	/** Every Skill with its versions, newest first; `description` is the current version's. */
	async list() {
		const [skills, versions] = await Promise.all([
			db.select().from(skill).orderBy(skill.name),
			db
				.select({
					id: skillVersion.id,
					skillName: skillVersion.skillName,
					number: skillVersion.number,
					description: skillVersion.description,
					createdAt: skillVersion.createdAt,
				})
				.from(skillVersion)
				.orderBy(desc(skillVersion.number)),
		]);
		return skills.map((s) => {
			const own = versions.filter((v) => v.skillName === s.name);
			return {
				name: s.name,
				enabled: s.enabled,
				currentVersionId: s.currentVersionId,
				description:
					own.find((v) => v.id === s.currentVersionId)?.description ?? "",
				versions: own.map(({ skillName: _, ...v }) => v),
			};
		});
	},

	/** Adds the zip as a new current version; one whose name exists needs `replace`. `name` is set once the zip is valid. */
	async upload(
		zip: Uint8Array,
		replace: boolean,
	): Promise<{ errors: SaveErrors; name?: string }> {
		const parsed = parseSkillZip(zip);
		if ("error" in parsed) return { errors: { file: parsed.error } };
		const { name } = parsed.skill;
		const errors = await write((tx) => addVersion(tx, parsed.skill, replace));
		return { errors, name };
	},

	/** A new Skill written in the console: its first version is a SKILL.md with only the frontmatter. */
	async create(
		name: string,
		description: string,
	): Promise<{ errors: SaveErrors }> {
		// checked before it goes into the YAML, where a line break could add keys
		if (!skillName.test(name))
			return { errors: { name: { code: "skill_name_invalid" } } };
		// a JSON string is a YAML double-quoted scalar
		const md = `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n\n`;
		const checked = checkSkill(
			[{ path: "SKILL.md", content: new TextEncoder().encode(md) }],
			name,
		);
		if ("error" in checked)
			return {
				errors: {
					[checked.error.code === "skill_description_invalid"
						? "description"
						: "name"]: checked.error,
				},
			};
		return {
			errors: await write((tx) => addVersion(tx, checked.skill, false)),
		};
	},

	/** A version's files for the console editor: `text` only for those that are UTF-8 text, the rest can only be kept or dropped. */
	files: async (versionId: number) =>
		(await skillFiles(versionId)).map(({ path, content }) => {
			const text = asText(content);
			return {
				path,
				size: content.length,
				...(text !== undefined && { text }),
			};
		}),

	/** Saves the Skill's files as a new current version: those with `text` as written, those without kept as they are in version `base`. */
	async edit(
		name: string,
		base: number,
		files: { path: string; text?: string }[],
	): Promise<{ errors: SaveErrors }> {
		const [version] = await db
			.select({ id: skillVersion.id })
			.from(skillVersion)
			.where(and(eq(skillVersion.id, base), eq(skillVersion.skillName, name)));
		if (!version) throw new SkillNotFound("base");
		const old = new Map(
			(await skillFiles(base)).map((f) => [f.path, f.content]),
		);
		const contents: SkillFile[] = [];
		for (const { path, text } of files) {
			const kept = old.get(path);
			// the console shows a binary file without its bytes, so text for it would replace it unseen
			if (text !== undefined && kept && asText(kept) === undefined)
				return { errors: { file: { code: "skill_file_binary", path } } };
			const content =
				text === undefined ? kept : new TextEncoder().encode(text);
			if (!content) return { errors: { file: { code: "not_found" } } };
			contents.push({ path, content });
		}
		const checked = checkSkill(contents, name);
		if ("error" in checked) return { errors: { file: checked.error } };
		return { errors: await write((tx) => addVersion(tx, checked.skill, true)) };
	},

	async setEnabled(name: string, enabled: boolean) {
		const updated = await write((tx) =>
			tx
				.update(skill)
				.set({ enabled })
				.where(eq(skill.name, name))
				.returning({ name: skill.name }),
		);
		if (!updated.length) throw new SkillNotFound("name");
	},

	/** Agents use this version from their next Run on; it must be one of the Skill's. */
	async setCurrent(name: string, versionId: number) {
		const updated = await write((tx) =>
			tx
				.update(skill)
				.set({ currentVersionId: versionId })
				.where(
					and(
						eq(skill.name, name),
						sql`exists (select 1 from ${skillVersion} where ${skillVersion.id} = ${versionId} and ${skillVersion.skillName} = ${name})`,
					),
				)
				.returning({ name: skill.name }),
		);
		if (!updated.length) throw new SkillNotFound("versionId");
	},

	/** Also deletes its versions and removes it from every Agent Definition. */
	delete: (name: string) =>
		write(async (tx) => {
			await tx.delete(skill).where(eq(skill.name, name));
			await tx.execute(
				sql`update ${agent} set definition = jsonb_set(definition, '{skills}', (definition->'skills') - ${name}::text) where definition->'skills' @> ${JSON.stringify([name])}::jsonb`,
			);
		}),
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
	providers: providers(deps),
	searchProviders: searchProviders(deps),
	mcpServers: mcpServers(deps),
	sandboxProvider: sandboxProviders(deps),
	documentParser: documentParsers(deps),
	limits: limitsOf(deps),
	agents: agents(deps),
	skills: skills(deps),
});
