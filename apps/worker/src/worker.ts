import type { OrqestraConfig } from "@orqestra/config";
import { createConversations } from "@orqestra/conversations";
import { openToolbox } from "@orqestra/tools";
import { runAgent } from "./runtime/index.ts";

/** Runs at most `max` functions at once, the rest in call order; one aborted while waiting leaves the queue and rejects. */
export function limiter(max: number) {
	let active = 0;
	const waiting: (() => void)[] = [];
	return async <T>(fn: () => Promise<T>, signal?: AbortSignal) => {
		signal?.throwIfAborted();
		if (active < max) active++;
		else
			await new Promise<void>((resolve, reject) => {
				const start = () => {
					signal?.removeEventListener("abort", stop);
					resolve();
				};
				const stop = () => {
					waiting.splice(waiting.indexOf(start), 1);
					reject(signal?.reason);
				};
				waiting.push(start);
				signal?.addEventListener("abort", stop, { once: true });
			});
		try {
			return await fn();
		} finally {
			// hand the slot straight to the next one, so no newcomer can slip in between
			const next = waiting.shift();
			if (next) next();
			else active--;
		}
	};
}

/**
 * Wraps a streamSimple so each Provider serves at most `max` Model requests at once, counted from the request until its stream ends.
 * The limits live as long as the returned function, so one Provider shares them across configs.
 */
export function providerLimiter(max: number) {
	const limits = new Map<string, ReturnType<typeof limiter>>();
	// shortcut: per worker process; several workers multiply the limit, move to a shared lock if that hits rate limits
	return (
		streamSimple: OrqestraConfig["streamSimple"],
	): OrqestraConfig["streamSimple"] =>
		(model, context, options) => {
			const limit = limits.get(model.provider) ?? limiter(max);
			limits.set(model.provider, limit);
			return new Promise((resolve, reject) => {
				limit(async () => {
					const stream = await streamSimple(model, context, options);
					resolve(stream);
					await stream.result();
				}, options?.signal).catch(reject);
			});
		};
}

/** Works on queued Runs in this process, replying to each, until the returned close function is called. */
export function startAgentWorker(
	// read per Run: a Run keeps the config it started with, the next one picks up a reload
	getConfig: () => Promise<OrqestraConfig>,
	{
		providerConcurrency = 8,
		...options
	}: Parameters<ReturnType<typeof createConversations>["serveRuns"]>[1] & {
		/** Model requests to one Provider at once, across this worker's Runs. */
		providerConcurrency?: number;
	} = {},
) {
	const limitProviders = providerLimiter(providerConcurrency);
	return createConversations({ config: getConfig }).serveRuns(
		(run, config) =>
			runAgent(run, {
				config,
				streamSimple: limitProviders(config.streamSimple),
				openToolbox,
			}),
		options,
	);
}
