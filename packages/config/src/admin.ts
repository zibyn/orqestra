import { type Db, db, type Tx } from "@orqestra/db";
import {
	documentParser,
	limits,
	sandboxProvider,
	searchProvider,
	toolService,
} from "@orqestra/db/schema";
import { decryptSecret, sealSecret, secretReadable } from "@orqestra/db/secret";
import { mcpServerAdmin } from "@orqestra/mcp";
import {
	availableTools,
	type DocumentParserTestResult,
	type SandboxTestResult,
	testDocumentParser,
	testSandboxProvider,
} from "@orqestra/tools";
import { eq } from "drizzle-orm";
import { z } from "zod";
import {
	DEFAULT_LIMITS,
	isMineruNet,
	type OrqestraConfig,
	type SaveErrors,
	type SearchProviderId,
	type SearchToolName,
	searchProviders as searchProviderCatalog,
	searchProviderId,
	searchToolName,
	spendingLimit,
	timeZone,
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

export const admin = (deps: Deps) => ({
	searchProviders: searchProviders(deps),
	mcpServers: mcpServerAdmin(deps),
	sandboxProvider: sandboxProviders(deps),
	documentParser: documentParsers(deps),
	limits: limitsOf(deps),
});
