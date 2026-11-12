import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "./schema.ts";

export const db = drizzle(process.env.DATABASE_URL as string, { schema });

export type Db = typeof db;

export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
