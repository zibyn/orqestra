import {
	type ConversationCapabilities,
	createConversations,
} from "@orqestra/conversations";
import {
	serveLinearEvents,
	serveLinearTokenRefresh,
} from "@orqestra/linear/events";
import {
	handleLinearEvent,
	reportFailureToLinear,
	reportingToLinear,
} from "./linear.ts";
import { type RuntimeDeps, runAgent, titlesSettled } from "./runtime/index.ts";
import { openToolbox } from "./runtime/toolbox.ts";

type Deps = Parameters<typeof createConversations>[0];

/**
 * Works on queued Runs and Linear's Agent Session events in this process, replying to each, and keeps the Linear app's tokens fresh,
 * until the returned close function is called.
 */
export async function startAgentWorker(
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
	const conversations = createConversations({
		capabilities,
		orrery,
		store,
		fetch,
		connections,
	});
	// Linear's requests go through `fetch` too: tests route each host to its fake
	const stopRuns = await conversations.serveRuns(
		reportingToLinear(
			(run, config) =>
				runAgent(run, {
					config,
					openToolbox: toolbox,
					telemetry,
					captureContent,
				}),
			{ fetch },
		),
		{
			...options,
			onFailed: (id, error) => reportFailureToLinear(id, error, { fetch }),
		},
	);
	const linear = await serveLinearEvents((event) =>
		handleLinearEvent(event, conversations, { fetch }),
	);
	const tokens = await serveLinearTokenRefresh({ fetch });
	// a Run's title outlives it: closing waits for those under way, so none is cut off with its Usage unrecorded
	return async () => {
		await tokens.close();
		await linear.close();
		await stopRuns();
		await titlesSettled();
	};
}
