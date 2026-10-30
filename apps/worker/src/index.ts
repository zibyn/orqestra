import { config } from "@orqestra/config/live";
import { startAgentWorker } from "./worker.ts";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set");

// throws on a missing ORQESTRA_ENCRYPTION_KEY or invalid stored config so the worker never starts with it
const loaded = await config.current();
console.log(
	`loaded ${loaded.agents.length} agent(s), default "${loaded.defaultAgent.id}"`,
);

const count = (name: string) => {
	const value = process.env[name];
	if (value === undefined) return undefined;
	const n = Number(value);
	if (!Number.isInteger(n) || n < 1)
		throw new Error(`${name} must be a positive integer`);
	return n;
};
const close = await startAgentWorker(config.current, {
	concurrency: count("WORKER_CONCURRENCY"),
	subagentConcurrency: count("SUBAGENT_CONCURRENCY"),
	providerConcurrency: count("PROVIDER_CONCURRENCY"),
});

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

console.log("worker listening on queues agent-runs and subagent-runs");
