import { db } from "@orqestra/db";
import { connectionStore } from "@orqestra/mcp";
import { s3Store } from "@orqestra/tools/s3";
import { createCapabilities } from "./capabilities.ts";
import { tracing } from "./tracing.ts";
import { startAgentWorker } from "./worker.ts";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set");
// throws on missing S3_* variables
const store = s3Store();

const config = createCapabilities(db);
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
const traces = tracing(process.env);
const close = await startAgentWorker(config, {
	concurrency: count("WORKER_CONCURRENCY"),
	subagentConcurrency: count("SUBAGENT_CONCURRENCY"),
	providerConcurrency: count("PROVIDER_CONCURRENCY"),
	store,
	connections: connectionStore,
	telemetry: traces.telemetry,
	captureContent: traces.captureContent,
});

for (const signal of ["SIGINT", "SIGTERM"]) {
	process.on(signal, async () => {
		// close() can wait forever if the database is unreachable
		// shortcut: 10s also cuts off active runs (they then fail and can be retried), revisit if that loses too much
		setTimeout(() => process.exit(1), 10_000).unref();
		await close();
		// spans still queued go before the exit; an unreachable backend only loses them
		await traces.shutdown().catch(() => {});
		await config.close();
		process.exit(0);
	});
}

console.log(
	"worker listening on queues agent-runs, subagent-runs, timers and firings",
);
