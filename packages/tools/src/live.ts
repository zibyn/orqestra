// What Admins configure for the built-in Tools and Sandboxes in /console: the Search Providers, the
// Sandbox Provider and the Document Parser, saved (after a connection test) and loaded here.
// Secrets only go in; a view tells whether they can still be decrypted.
import type { Db } from "@orqestra/db";
import { live } from "@orqestra/db/live";
import {
	documentParser,
	sandboxProvider,
	searchProvider,
	toolService,
} from "@orqestra/db/schema";
import {
	decryptSecret,
	encryptionKey,
	sealSecret,
	secretReadable,
} from "@orqestra/db/secret";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { ToolServices } from "./index.ts";
import {
	type SandboxProvider,
	type SandboxTestResult,
	testSandboxProvider,
} from "./orrery.ts";
import { type DocumentParserTestResult, testDocumentParser } from "./parse.ts";
import {
	isMineruNet,
	type SearchProviderId,
	type SearchToolName,
	searchProviders as searchProviderCatalog,
	searchProviderId,
	searchToolName,
	searchToolNames,
	toolName,
} from "./shared.ts";

/** NOTIFY channel, no payload: a Search Provider, the Sandbox Provider or the Document Parser changed. */
const TOOLS_CHANNEL = "tools_changed";

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

/** Why a field of a save was refused, as a code the console translates. */
type SaveErrors = Record<
	string,
	{ code: "api_key_required" | "token_required" }
>;

/** What an Admin configured for the Tools, as stored, secrets decrypted. */
export interface ToolSettings {
	/** `apiKey` is undefined when the stored key cannot be decrypted; `baseUrl` null means the official one. */
	searchProviders: {
		id: SearchProviderId;
		apiKey: string | undefined;
		baseUrl: string | null;
	}[];
	/** The Search Provider picked for each Tool. */
	servedBy: Record<SearchToolName, SearchProviderId | null>;
	/** Omitted when none is configured; `apiKey` is null when none is stored, undefined when it cannot be decrypted. */
	documentParser?: {
		enabled: boolean;
		url: string;
		apiKey: string | null | undefined;
	};
	/** Omitted when none is configured; `token` is undefined when it cannot be decrypted, `snapshot` null means orrery's default. */
	sandboxProvider?: {
		url: string;
		token: string | undefined;
		snapshot: string | null;
		cpu: number;
		memory: number;
	};
}

/** The usable services: a Tool or the Sandbox Provider whose key cannot be decrypted is left out. */
export interface ToolConfig {
	/** Tools with a usable Search Provider or Document Parser; the others are unavailable. */
	tools: ToolServices["tools"];
	/** Undefined when none is configured or its token cannot be decrypted: every Skill is then unavailable. */
	sandboxProvider?: SandboxProvider;
}

/** Resolves the stored settings to the services Runs use. */
export function loadTools(settings: ToolSettings): ToolConfig {
	const tools: ToolConfig["tools"] = {};
	for (const tool of searchToolNames) {
		const picked = settings.servedBy[tool];
		const stored = settings.searchProviders.find((p) => p.id === picked);
		if (picked && stored?.apiKey)
			tools[tool] = {
				provider: picked,
				apiKey: stored.apiKey,
				baseUrl:
					stored.baseUrl ||
					searchProviderCatalog.find((p) => p.id === picked)?.baseUrl ||
					"",
			};
	}
	const parser = settings.documentParser;
	if (parser?.enabled && parser.apiKey !== undefined)
		tools.parse = { baseUrl: parser.url, apiKey: parser.apiKey ?? "" };
	const stored = settings.sandboxProvider;
	const sandboxProvider = stored?.token
		? { ...stored, token: stored.token, snapshot: stored.snapshot ?? undefined }
		: undefined;
	return { tools, sandboxProvider };
}

/** Which Search Provider serves each Tool; null when none is picked. */
async function servedBy(db: Db) {
	const served = await db.select().from(toolService);
	const by = (tool: SearchToolName) =>
		(served.find((s) => s.tool === tool)?.searchProviderId ??
			null) as SearchProviderId | null;
	return { search: by("search"), scrape: by("scrape") };
}

async function loadSettings(db: Db): Promise<ToolSettings> {
	const key = encryptionKey();
	const [searchProviders, served, [sandbox], [parser]] = await Promise.all([
		db.select().from(searchProvider),
		servedBy(db),
		db.select().from(sandboxProvider),
		db.select().from(documentParser),
	]);
	return {
		searchProviders: searchProviders.map((p) => ({
			id: p.id as SearchProviderId,
			apiKey: decryptSecret(p.apiKey, key),
			baseUrl: p.baseUrl,
		})),
		servedBy: served,
		sandboxProvider: sandbox && {
			url: sandbox.url,
			token: decryptSecret(sandbox.token, key),
			snapshot: sandbox.snapshot,
			cpu: sandbox.cpu,
			memory: sandbox.memory,
		},
		documentParser: parser && {
			enabled: parser.enabled,
			url: parser.url,
			apiKey: parser.apiKey === null ? null : decryptSecret(parser.apiKey, key),
		},
	};
}

const logWarnings = (config: ToolConfig) => {
	for (const tool of toolName.options)
		if (!config.tools[tool])
			console.warn(
				`Tool "${tool}" has no usable ${tool === "parse" ? "Document Parser" : "Search Provider"}, so Agents run without it`,
			);
	return config;
};

// null keeps following the official one
const customBaseUrl = (url: string, fallback: string) =>
	url.replace(/\/+$/, "") === fallback.replace(/\/+$/, "") ? null : url;

// Orrery is the only Sandbox Provider and MinerU the only Document Parser, so each has one row with a fixed id
const ORRERY = "orrery";
const MINERU = "mineru";

/**
 * The Tools' config: `current()` for Runs, and what Admins edit in /console.
 * Loaded on the first `current()`; every write reloads it here and in every other process once committed.
 * Callers check that the User is an Admin.
 */
export function createTools(db: Db) {
	const config = live(db, {
		channel: TOOLS_CHANNEL,
		load: () => loadSettings(db).then(loadTools).then(logWarnings),
	});
	const { current, write } = config;

	const searchProviders = {
		/** Configured Search Providers, which one serves each Tool, and the Tools that are available. */
		async list() {
			const [rows, served, loaded] = await Promise.all([
				db.select().from(searchProvider).orderBy(searchProvider.createdAt),
				servedBy(db),
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
				available: searchToolNames.filter((t) => loaded.tools[t]),
			};
		},

		/** A blank key keeps the stored one, the official baseUrl is stored as null (it follows the official one). */
		async save(
			input: z.infer<typeof searchProviderInput>,
		): Promise<{ errors: SaveErrors }> {
			const official =
				searchProviderCatalog.find((p) => p.id === input.id)?.baseUrl ?? "";
			const baseUrl = customBaseUrl(input.baseUrl, official);
			const [stored] = await db
				.select({ apiKey: searchProvider.apiKey })
				.from(searchProvider)
				.where(eq(searchProvider.id, input.id));
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
	};

	const sandboxProviders = {
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
	};

	const documentParsers = {
		/** The configured one, or null; the key only goes in, `keyReadable` null when none is stored. */
		async get() {
			const row = await db.query.documentParser.findFirst();
			return row
				? {
						enabled: row.enabled,
						url: row.url,
						keyReadable:
							row.apiKey === null ? null : secretReadable(row.apiKey),
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
	};

	return {
		...config,
		searchProviders,
		sandboxProvider: sandboxProviders,
		documentParser: documentParsers,
	};
}

export type Tools = ReturnType<typeof createTools>;
