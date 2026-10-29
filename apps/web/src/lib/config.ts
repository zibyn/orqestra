import { liveConfig } from "@orqestra/config/live";
import { CONFIG_CHANNEL, db, sql } from "@orqestra/db";

// Reloaded whenever an Admin saves Providers, Models, Search Providers or Agents
export const config = liveConfig();

/** Tells web and worker to reload their config. */
export const reloadConfig = () =>
	db.execute(sql`select pg_notify(${CONFIG_CHANNEL}, '')`);
