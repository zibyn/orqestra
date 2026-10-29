import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "./schema.ts";

export const db = drizzle(process.env.DATABASE_URL!, { schema });

export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

// so apps (the worker) can query without their own drizzle-orm dependency
export { and, asc, desc, eq, inArray, ne, sql } from "drizzle-orm";

/** NOTIFY channel, no payload: Providers or enabled Models changed, reload the config (web -> web and worker). */
export const CONFIG_CHANNEL = "config_changed";
