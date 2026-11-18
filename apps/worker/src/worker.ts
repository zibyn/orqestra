import {
	type ConversationCapabilities,
	createConversations,
	handleSessionEvent,
	reportingToSessions,
	reportSessionFailure,
} from "@orqestra/conversations";
import { serveEvents, serveTokenRefresh } from "@orqestra/integrations";
import { linear } from "@orqestra/integrations/linear";
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
		reportingToSessions(
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
			onFailed: (id, error, jobId) =>
				reportSessionFailure(id, error, jobId, { fetch }),
		},
	);
	const events = await serveEvents(linear, (event) =>
		handleSessionEvent(linear, event, conversations, { fetch }),
	);
	const tokens = await serveTokenRefresh(linear, { fetch });
	// a Run's title outlives it: closing waits for those under way, so none is cut off with its Usage unrecorded
	return async () => {
		await tokens.close();
		await events.close();
		await stopRuns();
		await titlesSettled();
	};
}
