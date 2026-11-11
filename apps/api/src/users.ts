import { db } from "@orqestra/db";
import { user } from "@orqestra/db/schema";
import { desc, sql } from "drizzle-orm";
import { Elysia } from "elysia";
import { adminOnly } from "./admin.ts";
import type { Session, SignedIn } from "./app.ts";

/**
 * session, also remembering whoever it reads (ADR 0008): their name and email, written only when they
 * change, and their last-active time, moved at most hourly. Never whether they are an Admin.
 */
export const rememberUsers =
	(session: Session): Session =>
	async (request) => {
		const read = await session(request);
		if (!read.user) return read;
		const { id, name, email } = read.user;
		const stale = sql`${user.lastActiveAt} < excluded.last_active_at - interval '1 hour'`;
		await db
			.insert(user)
			.values({ id, name, email: email ?? null, lastActiveAt: new Date() })
			.onConflictDoUpdate({
				target: user.id,
				set: {
					name: sql`excluded.name`,
					email: sql`excluded.email`,
					lastActiveAt: sql`case when ${stale} then excluded.last_active_at else ${user.lastActiveAt} end`,
				},
				setWhere: sql`${user.name} is distinct from excluded.name or ${user.email} is distinct from excluded.email or ${stale}`,
			});
		return read;
	};

// The Users who have used Orqestra, for the console's Users page
export const users = (signedIn: SignedIn) =>
	new Elysia({ prefix: "/users" })
		.use(signedIn)
		.derive(adminOnly)
		.get("/", async () => ({
			users: await db.select().from(user).orderBy(desc(user.lastActiveAt)),
		}));
