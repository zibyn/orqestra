import { catalogProviders, modelRef } from "@orqestra/config";
import { db } from "@orqestra/db";
import { agent, enabledModel, usage } from "@orqestra/db/schema";
import {
	and,
	count,
	desc,
	eq,
	gte,
	isNull,
	lt,
	type SQL,
	sql,
	sum,
} from "drizzle-orm";
import { Elysia } from "elysia";
import { z } from "zod";
import { signedInOnly } from "./admin.ts";
import type { SignedIn } from "./app.ts";

const instant = z.iso.datetime({ offset: true }).transform((s) => new Date(s));

/**
 * A Usage summary's query: the range [from, to), its ends worked out by the browser in its own time zone;
 * the dimension to group by; and filters to drill down: `agent` an Agent's id, or empty for the general
 * worker, `model` a Model's `provider/id`.
 */
export const usageQuery = z.object({
	from: instant,
	to: instant,
	group: z.enum(["agent", "model"]),
	agent: z.string().optional(),
	model: z.string().optional(),
});

export type UsageQuery = z.infer<typeof usageQuery> & { user?: string };

const totals = {
	requests: count(),
	inputTokens: sum(usage.inputTokens).mapWith(Number),
	outputTokens: sum(usage.outputTokens).mapWith(Number),
	cacheReadTokens: sum(usage.cacheReadTokens).mapWith(Number),
	cacheWriteTokens: sum(usage.cacheWriteTokens).mapWith(Number),
	cost: sum(usage.cost).mapWith(Number),
};

/**
 * Usage in a range, one row per group, costliest first, with what to show for it. An Agent: its
 * name when last used, `deleted` once its Agent Definition is gone; the general worker's key and
 * name are null. A Model: its Catalog name, `disabled` once it is no longer enabled.
 */
export async function summarizeUsage(q: UsageQuery) {
	const filters: (SQL | undefined)[] = [
		gte(usage.createdAt, q.from),
		lt(usage.createdAt, q.to),
		q.user === undefined ? undefined : eq(usage.userId, q.user),
		q.agent === undefined
			? undefined
			: q.agent === ""
				? isNull(usage.agentId)
				: eq(usage.agentId, q.agent),
		q.model === undefined
			? undefined
			: sql`${usage.provider} || '/' || ${usage.modelId} = ${q.model}`,
	];
	const where = and(...filters);

	if (q.group === "agent")
		return db
			.select({
				key: usage.agentId,
				name: sql<
					string | null
				>`(array_agg(${usage.agentName} order by ${usage.createdAt} desc))[1]`,
				deleted: sql<boolean>`${usage.agentId} is not null and not exists (select 1 from ${agent} where ${agent.id} = ${usage.agentId})`,
				...totals,
			})
			.from(usage)
			.where(where)
			.groupBy(usage.agentId)
			.orderBy(desc(totals.cost));

	const [rows, enabled, catalog] = await Promise.all([
		db
			.select({ provider: usage.provider, id: usage.modelId, ...totals })
			.from(usage)
			.where(where)
			.groupBy(usage.provider, usage.modelId)
			.orderBy(desc(totals.cost)),
		db.select().from(enabledModel),
		catalogProviders(),
	]);
	const on = new Set(
		enabled.map((e) => modelRef({ provider: e.providerId, id: e.modelId })),
	);
	const names = new Map(
		catalog.flatMap((p) => p.models.map((m) => [modelRef(m), m.name])),
	);
	return rows.map(({ provider, id, ...sums }) => {
		const key = modelRef({ provider, id });
		return { key, name: names.get(key) ?? id, disabled: !on.has(key), ...sums };
	});
}

/** /api/usage/mine: the signed-in User's own Usage, nobody else's, Admins included. */
export const usageRoutes = (signedIn: SignedIn) =>
	new Elysia({ prefix: "/usage" })
		.use(signedIn)
		.derive(signedInOnly)
		.get(
			"/mine",
			async ({ user, query }) => ({
				rows: await summarizeUsage({ ...query, user: user.id }),
			}),
			{ query: usageQuery },
		);
