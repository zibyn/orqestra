import {
	type ConversationCapabilities,
	createConversations,
} from "@orqestra/conversations";
import { type RuntimeDeps, runAgent } from "./runtime/index.ts";
import { openToolbox } from "./runtime/toolbox.ts";

type Deps = Parameters<typeof createConversations>[0];

/** Works on queued Runs in this process, replying to each, until the returned close function is called. */
export function startAgentWorker(
	// `current` read per Run: a Run keeps the config it started with, the next one picks up a reload
	capabilities: ConversationCapabilities,
	{
		toolbox = openToolbox,
		orrery,
		store,
		fetch,
		connections,
		telemetry,
		captureContent,
		...options
	}: Parameters<ReturnType<typeof createConversations>["serveRuns"]>[1] &
		Omit<Deps, "capabilities"> & {
			/** Opens each Run's Tools; tests stand in for the services behind them. */
			toolbox?: typeof openToolbox;
			/** Where Run traces go; nowhere by default. */
			telemetry?: RuntimeDeps["telemetry"];
			/** Run traces also carry what was said. */
			captureContent?: boolean;
		},
) {
	return createConversations({
		capabilities,
		orrery,
		store,
		fetch,
		connections,
	}).serveRuns(
		(run, config) =>
			runAgent(run, {
				config,
				openToolbox: toolbox,
				telemetry,
				captureContent,
			}),
		options,
	);
}
