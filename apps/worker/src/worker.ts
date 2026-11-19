import {
	type ConversationCapabilities,
	createConversations,
	handleSessionEvent,
	reportingToSessions,
	reportSessionFailure,
} from "@orqestra/conversations";
import {
	queueEvent,
	serveEvents,
	serveStream,
	serveTokenRefresh,
} from "@orqestra/integrations";
import { sources } from "@orqestra/integrations/sources";
import { type RuntimeDeps, runAgent, titlesSettled } from "./runtime/index.ts";
import { openToolbox } from "./runtime/toolbox.ts";

type Deps = Parameters<typeof createConversations>[0];

/**
 * Works on queued Runs and every source's Integration Session events in this process, replying to each, keeps the OAuth apps' tokens
 * fresh, and holds the connection of each source that pushes its events down one, until the returned close function is called.
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
		orqestraUrl,
		...options
	}: Parameters<ReturnType<typeof createConversations>["serveRuns"]>[1] &
		Omit<Deps, "capabilities"> & {
			/** Opens each Run's Tools; tests stand in for the services behind them. */
			toolbox?: typeof openToolbox;
			/** Where Run traces go; nowhere by default. */
			telemetry?: RuntimeDeps["telemetry"];
			/** Run traces also carry what was said. */
			captureContent?: boolean;
			/** Where Orqestra is served, `ORQESTRA_URL`: a session's sender is sent to its Connections page to link their account. */
			orqestraUrl?: string;
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
	// each source's events, however they arrive, are worked on from its queue; a held connection only queues them
	const served = await Promise.all(
		sources.map(async (source) => {
			const events = await serveEvents(source, (event) =>
				handleSessionEvent(source, event, conversations, {
					fetch,
					orqestraUrl,
				}),
			);
			const tokens =
				source.install.mode === "oauth" &&
				(await serveTokenRefresh(source, { fetch }));
			const stream =
				source.ingress.mode === "stream" &&
				serveStream(source, (event) => queueEvent(source, event), { fetch });
			return async () => {
				if (stream) await stream();
				if (tokens) await tokens.close();
				await events.close();
			};
		}),
	);
	// a Run's title outlives it: closing waits for those under way, so none is cut off with its Usage unrecorded
	return async () => {
		await Promise.all(served.map((close) => close()));
		await stopRuns();
		await titlesSettled();
	};
}
