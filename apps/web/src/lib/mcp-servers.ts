import { mcpServerId, mcpToolRef } from "@orqestra/config";
import { decryptSecret, encryptSecret } from "@orqestra/config/secret";
import { db, eq, sql } from "@orqestra/db";
import { agent, mcpServer } from "@orqestra/db/schema";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { reloadConfig } from "#/lib/config";
import { type McpTestResult, testMcpServer } from "#/lib/mcp-connection";
import { requireAdmin } from "#/lib/session";

// MCP Servers, edited by Admins in /console/providers. Header values only go in.

// RFC 7230 token
const headerName = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

export const getMcpServers = createServerFn().handler(async () => {
	await requireAdmin();
	const rows = await db.select().from(mcpServer).orderBy(mcpServer.createdAt);
	return rows.map((r) => ({
		id: r.id,
		name: r.name,
		url: r.url,
		enabled: r.enabled,
		headers: r.headers.map((h) => ({
			name: h.name,
			readable: decryptSecret(h.value) !== undefined,
		})),
	}));
});

/** Field errors by name (`id`, `headers`), as codes to translate; empty when it was saved, then with the connection test's result. */
export const saveMcpServer = createServerFn({ method: "POST" })
	.validator(
		z.object({
			// checked in the handler, so a bad id lands on the id field
			id: z.string(),
			create: z.boolean(),
			name: z.string().trim().min(1),
			url: z.url({ protocol: /^https?$/ }),
			enabled: z.boolean(),
			headers: z.array(
				z.object({
					name: z.string().trim().min(1),
					// blank keeps the stored value of the header with this name
					value: z.string().trim().optional(),
				}),
			),
		}),
	)
	.handler(async ({ data }): Promise<SaveResult> => {
		await requireAdmin();
		if (!mcpServerId.safeParse(data.id).success)
			return { errors: { id: { code: "id_invalid" } } };
		const stored = await db.query.mcpServer.findFirst({
			where: eq(mcpServer.id, data.id),
		});
		if (data.create && stored) return { errors: { id: { code: "id_taken" } } };
		if (!data.create && !stored) throw new Error("MCP Server not found");
		const headers = [];
		const plain: Record<string, string> = {};
		const seen = new Set<string>();
		for (const h of data.headers) {
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
			headers.push({ name: header, value: kept ?? encryptSecret(value) });
			plain[header] = value;
		}
		const values = {
			name: data.name,
			url: data.url,
			enabled: data.enabled,
			headers,
		};
		if (stored)
			await db.update(mcpServer).set(values).where(eq(mcpServer.id, data.id));
		else await db.insert(mcpServer).values({ id: data.id, ...values });
		await reloadConfig();
		// saved either way, so the Admin can fix the URL or headers later
		return {
			errors: {},
			test: await testMcpServer({ url: data.url, headers: plain }),
		};
	});

export type McpSaveError =
	| { code: "id_invalid" | "id_taken" }
	| {
			code: "header_invalid" | "header_twice" | "header_value_missing";
			header: string;
	  };
type SaveResult = {
	errors: { id?: McpSaveError; headers?: McpSaveError };
	test?: McpTestResult;
};

export const setMcpServerEnabled = createServerFn({ method: "POST" })
	.validator(z.object({ id: mcpServerId, enabled: z.boolean() }))
	.handler(async ({ data }) => {
		await requireAdmin();
		const updated = await db
			.update(mcpServer)
			.set({ enabled: data.enabled })
			.where(eq(mcpServer.id, data.id))
			.returning({ id: mcpServer.id });
		if (!updated.length) throw new Error("MCP Server not found");
		await reloadConfig();
	});

export const deleteMcpServer = createServerFn({ method: "POST" })
	.validator(mcpServerId)
	.handler(async ({ data }) => {
		await requireAdmin();
		const ref = mcpToolRef(data);
		await db.transaction(async (tx) => {
			await tx.delete(mcpServer).where(eq(mcpServer.id, data));
			// no Agent Definition may keep pointing at it
			await tx.execute(
				sql`update ${agent} set definition = jsonb_set(definition, '{tools}', (definition->'tools') - ${ref}::text) where definition->'tools' @> ${JSON.stringify([ref])}::jsonb`,
			);
		});
		await reloadConfig();
	});
