import { mcpServerId } from "@orqestra/config";
import { decryptSecret, encryptSecret } from "@orqestra/config/secret";
import { db, eq } from "@orqestra/db";
import { mcpServer } from "@orqestra/db/schema";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { reloadConfig } from "#/lib/config";
import { requireAdmin } from "#/lib/session";

// MCP Servers, edited by Admins in /console/providers. Header values only go in.

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

/** Field errors by name (`id`, `headers`); empty when it was saved. */
export const saveMcpServer = createServerFn({ method: "POST" })
	.validator(
		z.object({
			id: mcpServerId,
			create: z.boolean(),
			name: z.string().trim().min(1),
			url: z.url({ protocol: /^https?$/ }),
			enabled: z.boolean(),
			headers: z.array(
				z.object({
					name: z.string().trim().min(1),
					// blank keeps the stored value of the header with this name
					value: z.string().optional(),
				}),
			),
		}),
	)
	.handler(async ({ data }): Promise<{ errors: Record<string, string> }> => {
		await requireAdmin();
		const stored = await db.query.mcpServer.findFirst({
			where: eq(mcpServer.id, data.id),
		});
		if (data.create && stored)
			return { errors: { id: "An MCP Server with this id already exists" } };
		if (!data.create && !stored) throw new Error("MCP Server not found");
		const headers = [];
		for (const h of data.headers) {
			const kept = stored?.headers.find((s) => s.name === h.name)?.value;
			const value = h.value
				? encryptSecret(h.value)
				: kept && decryptSecret(kept) !== undefined
					? kept
					: undefined;
			if (!value)
				return { errors: { headers: `Enter a value for header ${h.name}` } };
			headers.push({ name: h.name, value });
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
		return { errors: {} };
	});

export const setMcpServerEnabled = createServerFn({ method: "POST" })
	.validator(z.object({ id: mcpServerId, enabled: z.boolean() }))
	.handler(async ({ data }) => {
		await requireAdmin();
		await db
			.update(mcpServer)
			.set({ enabled: data.enabled })
			.where(eq(mcpServer.id, data.id));
		await reloadConfig();
	});

export const deleteMcpServer = createServerFn({ method: "POST" })
	.validator(mcpServerId)
	.handler(async ({ data }) => {
		await requireAdmin();
		await db.delete(mcpServer).where(eq(mcpServer.id, data));
		await reloadConfig();
	});
