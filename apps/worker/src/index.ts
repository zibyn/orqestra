import { liveConfig } from "@orqestra/config/live";
import { startAgentWorker } from "./run.ts";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is not set");

// throws on a missing ORQESTRA_ENCRYPTION_KEY or invalid stored config so the worker never starts with it
const config = liveConfig();
const loaded = await config.get();
console.log(
	`loaded ${loaded.agents.length} agent(s), default "${loaded.defaultAgent.id}"`,
);

const close = await startAgentWorker(config.get, databaseUrl);

for (const signal of ["SIGINT", "SIGTERM"]) {
	process.on(signal, async () => {
		// close() can wait forever if the database is unreachable
		// shortcut: 10s also cuts off active runs (they then fail and can be retried), revisit if that loses too much
		setTimeout(() => process.exit(1), 10_000).unref();
		await close();
		await config.close();
		process.exit(0);
	});
}

console.log("worker listening on queue agent-runs");
