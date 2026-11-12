import type { UsagePurpose } from "@orqestra/db/schema";
import type { StreamSimple } from "@orqestra/models";
import { SpendingLimitReached } from "./spending.ts";

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
	return (streamSimple: StreamSimple): StreamSimple =>
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

/** One Model request as Usage: what it was for, the Model, the tokens and the cost its Provider reported. */
export type Counted = {
	purpose: UsagePurpose;
	provider: string;
	modelId: string;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	cost: number;
};

/**
 * A Run's Model requests, for the purpose its caller names: each first checked against its User's Spending Limit (`reached`),
 * throwing SpendingLimitReached unsent once it is used up, then `record`ed as Usage once its stream ends, whether it finished,
 * failed or was stopped, at the cost the Provider reported; nothing is recorded when the Provider reported no usage.
 */
export const metered =
	(
		streamSimple: StreamSimple,
		user: {
			reached: () => Promise<boolean>;
			record: (counted: Counted) => Promise<unknown>;
		},
	) =>
	(purpose: UsagePurpose): StreamSimple =>
	async (model, context, options) => {
		if (await user.reached()) throw new SpendingLimitReached();
		const stream = await streamSimple(model, context, options);
		// not awaited: the reply goes on while it is written
		stream
			.result()
			.then(async ({ usage }) => {
				const tokens = {
					inputTokens: usage.input,
					outputTokens: usage.output,
					cacheReadTokens: usage.cacheRead,
					cacheWriteTokens: usage.cacheWrite,
				};
				// all zero: the request never reached the Provider (pi reports a failed connection so), nothing to count
				if (!Object.values(tokens).some(Boolean)) return;
				await user.record({
					purpose,
					provider: model.provider,
					modelId: model.id,
					...tokens,
					// as the Provider of pi priced it, at the Model's (perhaps custom) price, with pricing like service tiers that recomputing would lose
					cost: usage.cost.total,
				});
			})
			.catch((error) => console.error("recording Usage failed", error));
		return stream;
	};
