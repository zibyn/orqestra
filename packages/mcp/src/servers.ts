// MCP Servers as Admins edit them in /console/mcp, and as they are loaded for Runs. Header values and Client secrets only go in.
import { type Db, db, type Tx } from "@orqestra/db";
import { live } from "@orqestra/db/live";
import { mcpServer } from "@orqestra/db/schema";
import {
	decryptSecret,
	encryptionKey,
	sealSecret,
	secretReadable,
} from "@orqestra/db/secret";
import { eq } from "drizzle-orm";
import { z } from "zod";
import {
	clearConnections,
	connectedUsers,
	revokeConnections,
} from "./connections.ts";
import type { McpServer } from "./index.ts";
import { type McpTestResult, probeMcpServer } from "./mcp.ts";
import type { OrqestraReach } from "./oauth.ts";

/** NOTIFY channel, no payload: an MCP Server changed, reload them (web -> web and worker). */
const MCP_CHANNEL = "mcp_changed";

/** An MCP Server's id, like an Agent's; never changes, since Agent Definitions and Tool names refer to it. */
export const mcpServerId = z
	.string()
	.regex(/^[a-z0-9][a-z0-9-]*$/, "lowercase letters, digits and dashes");

export const mcpServerInput = z.object({
	// checked in save, so a bad id lands on the id field
	id: z.string(),
	create: z.boolean(),
	name: z.string().trim().min(1),
	url: z.url({ protocol: /^https?$/ }),
	enabled: z.boolean(),
	// a Client pre-registered with the authorization server, making it per-User OAuth; blank: none
	oauthClientId: z.string().trim().optional(),
	// blank keeps the stored secret
	oauthClientSecret: z.string().trim().optional(),
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

/** Field errors of a save by field name; empty when it was saved. */
type SaveErrors = Record<
	string,
	| { code: "id_invalid" | "id_taken" | "not_found" }
	| {
			code:
				| "header_invalid"
				| "header_twice"
				| "header_value_missing"
				| "header_reserved";
			header: string;
	  }
>;

// RFC 7230 token
const headerName = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/** The MCP Server's pre-registered Client, its secret decrypted (undefined when it no longer decrypts). */
export const storedClient = (
	row: Pick<
		typeof mcpServer.$inferSelect,
		"oauthClientId" | "oauthClientSecret"
	>,
	key?: Buffer,
) =>
	row.oauthClientId
		? {
				client_id: row.oauthClientId,
				client_secret:
					(row.oauthClientSecret &&
						decryptSecret(row.oauthClientSecret, key)) ||
					undefined,
			}
		: undefined;

/** Every MCP Server as stored, decrypted; a header `value` is undefined when it cannot be decrypted. */
export type McpServerSettings = {
	id: string;
	name: string;
	url: string;
	enabled: boolean;
	auth: "shared" | "oauth";
	/** `client_secret` is undefined when there is none or it cannot be decrypted. */
	oauthClient?: {
		client_id: string;
		client_secret: string | undefined;
	} | null;
	headers: { name: string; value: string | undefined }[];
}[];

/** Every MCP Server, decrypted with `key`. */
export const loadMcpServers = async (
	from: Db,
	key?: Buffer,
): Promise<McpServerSettings> =>
	(await from.select().from(mcpServer).orderBy(mcpServer.createdAt)).map(
		(s) => ({
			id: s.id,
			name: s.name,
			url: s.url,
			enabled: s.enabled,
			auth: s.auth,
			oauthClient: storedClient(s, key) ?? null,
			headers: s.headers.map((h) => ({
				name: h.name,
				value: decryptSecret(h.value, key),
			})),
		}),
	);

/** The MCP Servers a Run can use: those whose headers decrypt, by id. */
export interface McpSnapshot {
	/** Enabled MCP Servers whose headers decrypt, by id; the others are unavailable. */
	mcpServers: Record<string, McpServer>;
	/** Every MCP Server whose headers decrypt, disabled ones included, by id: what deleting one cancels its Background Calls with. */
	allMcpServers: Record<string, McpServer>;
}

/** The stored MCP Servers as Runs use them. */
export function resolveMcpServers(settings: McpServerSettings): McpSnapshot {
	const mcpServers: McpSnapshot["mcpServers"] = {};
	const allMcpServers: McpSnapshot["allMcpServers"] = {};
	for (const {
		id,
		name,
		url,
		enabled,
		auth,
		oauthClient,
		headers,
	} of settings) {
		const plain = headers.flatMap((h) =>
			h.value === undefined ? [] : [[h.name, h.value]],
		);
		// one unreadable header: the server would reject us, so it is unavailable
		if (plain.length !== headers.length) continue;
		allMcpServers[id] = {
			name,
			url,
			auth,
			...(oauthClient && { oauthClient }),
			headers: Object.fromEntries(plain),
		};
		if (enabled) mcpServers[id] = allMcpServers[id];
	}
	return { mcpServers, allMcpServers };
}

/**
 * The MCP Servers: `current()` for Runs, and what Admins edit in /console/mcp. Loaded on the first `current()`, which rejects when
 * that fails (also on a missing ORQESTRA_ENCRYPTION_KEY); every write reloads them here and in every other process once committed.
 */
export function createMcpServers(from: Db) {
	const servers = live(from, {
		channel: MCP_CHANNEL,
		load: async () =>
			resolveMcpServers(await loadMcpServers(from, encryptionKey())),
	});
	return { ...servers, ...mcpServerAdmin(servers) };
}

export type McpServersLive = ReturnType<typeof createMcpServers>;

/**
 * In `tx`, deletes the MCP Server and every Connection to it, their tokens taken before the cascade would delete them; what revoking
 * them needs, after the commit.
 */
export async function deleteMcpServer(tx: Tx, id: string) {
	const [stored] = await tx
		.select()
		.from(mcpServer)
		.where(eq(mcpServer.id, id))
		.for("update");
	const cleared = stored
		? await clearConnections(tx, id, storedClient(stored))
		: [];
	await tx.delete(mcpServer).where(eq(mcpServer.id, id));
	return cleared;
}

/** What Admins edit of MCP Servers; `write` runs a transaction, then tells every process to reload. Callers check the User is an Admin. */
export const mcpServerAdmin = ({
	write,
}: {
	write: <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>;
}) => ({
	async list() {
		const [rows, connected] = await Promise.all([
			db.select().from(mcpServer).orderBy(mcpServer.createdAt),
			connectedUsers(),
		]);
		return rows.map((r) => ({
			id: r.id,
			name: r.name,
			url: r.url,
			enabled: r.enabled,
			auth: r.auth,
			oauthClientId: r.oauthClientId,
			oauthClientSecret: r.oauthClientSecret
				? { readable: secretReadable(r.oauthClientSecret) }
				: null,
			headers: r.headers.map((h) => ({
				name: h.name,
				readable: secretReadable(h.value),
			})),
			// the Admin sees who relies on it, but cannot disconnect them
			...(r.auth === "oauth" && { connections: connected[r.id] ?? [] }),
		}));
	},

	/**
	 * Tests it first, which finds how it is signed in to (see probeMcpServer); once saved, also the test's result. `fetch` makes the
	 * test's requests and revocations. A new auth mode, URL or pre-registered Client ends every Connection to it, revoked in the
	 * background once committed.
	 */
	async save(
		input: z.infer<typeof mcpServerInput>,
		{ fetch }: Pick<OrqestraReach, "fetch"> = {},
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
			// each User's Connection authorizes a server with a pre-registered Client
			if (input.oauthClientId && header.toLowerCase() === "authorization")
				return { errors: { headers: { code: "header_reserved", header } } };
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
		const oauthClientId = input.oauthClientId || null;
		const { auth: found, test } = await probeMcpServer(
			{ url: input.url, headers: plain, preRegistered: !!oauthClientId },
			{ fetch },
		);
		// one that did not answer keeps how it was signed in to, and its Connections
		const auth = found ?? stored?.auth ?? "shared";
		const values = {
			name: input.name,
			url: input.url,
			enabled: input.enabled,
			auth,
			oauthClientId,
			// a secret belongs to its Client: none without one
			oauthClientSecret:
				(oauthClientId &&
					sealSecret(
						input.oauthClientSecret,
						stored?.oauthClientSecret ?? undefined,
					)) ||
				null,
			headers,
		};
		const oldClient = stored && storedClient(stored);
		// Connections made for another setup must never reach the new one
		const reset =
			stored &&
			(stored.auth !== auth ||
				stored.url !== input.url ||
				stored.oauthClientId !== oauthClientId ||
				(!!oauthClientId &&
					!!input.oauthClientSecret &&
					input.oauthClientSecret !== oldClient?.client_secret));
		const cleared = await write(async (tx) => {
			await tx
				.insert(mcpServer)
				.values({ id: input.id, ...values })
				.onConflictDoUpdate({ target: mcpServer.id, set: values });
			return reset ? clearConnections(tx, input.id, oldClient) : [];
		});
		// shortcut: in the background so the save does not wait on authorization servers; lost if the process exits first
		if (cleared.length) void revokeConnections(cleared, { fetch });
		// saved either way, so the Admin can fix the URL or headers later
		return { errors: {}, test };
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
});
