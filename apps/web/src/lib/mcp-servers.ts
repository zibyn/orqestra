import { mcpServerId } from "@orqestra/config";
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

/** Field errors by name (`id`, `headers`); empty when it was saved, then with the connection test's result. */
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
		const id = mcpServerId.safeParse(data.id);
		if (!id.success) return { errors: { id: id.error.issues[0].message } };
		const stored = await db.query.mcpServer.findFirst({
			where: eq(mcpServer.id, data.id),
		});
		if (data.create && stored)
			return { errors: { id: "An MCP Server with this id already exists" } };
		if (!data.create && !stored) throw new Error("MCP Server not found");
		const headers = [];
		const plain: Record<string, string> = {};
		const seen = new Set<string>();
		for (const h of data.headers) {
			if (!headerName.test(h.name))
				return {
					errors: { headers: `"${h.name}" is not a valid header name` },
				};
			if (seen.has(h.name.toLowerCase()))
				return { errors: { headers: `Header ${h.name} is listed twice` } };
			seen.add(h.name.toLowerCase());
			const kept = stored?.headers.find((s) => s.name === h.name)?.value;
			const value = h.value
				? encryptSecret(h.value)
				: kept && decryptSecret(kept) !== undefined
					? kept
					: undefined;
			if (!value)
				return { errors: { headers: `Enter a value for header ${h.name}` } };
			headers.push({ name: h.name, value });
			plain[h.name] = h.value || (decryptSecret(value) as string);
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

type SaveResult = { errors: Record<string, string>; test?: McpTestResult };

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
		const ref = `mcp:${data}`;
		await db.transaction(async (tx) => {
			await tx.delete(mcpServer).where(eq(mcpServer.id, data));
			// no Agent Definition may keep pointing at it
			await tx.execute(
				sql`update ${agent} set definition = jsonb_set(definition, '{tools}', (definition->'tools') - ${ref}::text) where definition->'tools' @> ${JSON.stringify([ref])}::jsonb`,
			);
		});
		await reloadConfig();
	});
