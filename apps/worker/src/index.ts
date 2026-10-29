import { loadConfig } from "@orqestra/config";
import { startAgentWorker } from "./run.ts";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is not set");

// throws on a bad config dir so the worker never starts with it
const config = await loadConfig();
console.log(
	`loaded ${config.agents.length} agent(s), default "${config.defaultAgent.id}"`,
);

const close = await startAgentWorker(config, databaseUrl);

for (const signal of ["SIGINT", "SIGTERM"]) {
	process.on(signal, async () => {
		// close() can wait forever if the database is unreachable
		// shortcut: 10s also cuts off active runs (they then fail and can be retried), revisit if that loses too much
		setTimeout(() => process.exit(1), 10_000).unref();
		await close();
		process.exit(0);
	});
}

console.log("worker listening on queue agent-runs");
