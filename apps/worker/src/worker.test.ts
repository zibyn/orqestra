import { describe, expect, it } from "bun:test";
import { limiter, providerLimiter } from "./worker.ts";

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("limiter", () => {
	it("runs at most max at once, the rest in call order", async () => {
		const limit = limiter(2);
		const started: number[] = [];
		const done: (() => void)[] = [];
		const runs = [0, 1, 2, 3].map((i) =>
			limit(
				() =>
					new Promise<void>((resolve) => {
						started.push(i);
						done[i] = resolve;
					}),
			),
		);
		await tick();
		expect(started).toEqual([0, 1]);
		done[1]();
		await tick();
		expect(started).toEqual([0, 1, 2]);
		done[0]();
		done[2]();
		await tick();
		done[3]();
		await Promise.all(runs);
		expect(started).toEqual([0, 1, 2, 3]);
	});

	it("drops a waiting call when its signal aborts, and never starts it", async () => {
		const limit = limiter(1);
		let release = () => {};
		const first = limit(() => new Promise<void>((r) => (release = r)));
		const stop = new AbortController();
		let ran = false;
		const waiting = limit(async () => {
			ran = true;
		}, stop.signal);
		stop.abort(new Error("stopped"));
		await expect(waiting).rejects.toThrow("stopped");
		// the slot goes to the next caller, not the dropped one
		const next = limit(async () => "next");
		release();
		await first;
		expect(await next).toBe("next");
		expect(ran).toBe(false);
	});

	it("rejects at once when the signal is already aborted", async () => {
		const stop = new AbortController();
		stop.abort(new Error("stopped"));
		await expect(limiter(1)(async () => {}, stop.signal)).rejects.toThrow(
			"stopped",
		);
	});
});

describe("providerLimiter", () => {
	// a stream that ends when its test says so
	function streams() {
		const started: string[] = [];
		const end: Record<string, () => void> = {};
		const streamSimple = ((model: { provider: string; id: string }) => {
			started.push(model.id);
			const result = new Promise((resolve) => {
				end[model.id] = () => resolve({});
			});
			return { result: () => result };
		}) as unknown as Parameters<ReturnType<typeof providerLimiter>>[0];
		return { started, end, streamSimple };
	}
	const model = (provider: string, id: string) => ({ provider, id }) as never;

	it("holds a Provider's slot until the stream ends, without blocking other Providers", async () => {
		const { started, end, streamSimple } = streams();
		const limited = providerLimiter(1)(streamSimple);
		void limited(model("a", "a1"), { messages: [] });
		void limited(model("a", "a2"), { messages: [] });
		void limited(model("b", "b1"), { messages: [] });
		await tick();
		expect(started).toEqual(["a1", "b1"]);
		end.a1();
		await tick();
		expect(started).toEqual(["a1", "b1", "a2"]);
	});

	it("drops a queued request when its signal aborts", async () => {
		const { started, streamSimple } = streams();
		const limited = providerLimiter(1)(streamSimple);
		void limited(model("a", "a1"), { messages: [] });
		const stop = new AbortController();
		const queued = limited(
			model("a", "a2"),
			{ messages: [] },
			{ signal: stop.signal },
		);
		stop.abort(new Error("stopped"));
		await expect(queued).rejects.toThrow("stopped");
		expect(started).toEqual(["a1"]);
	});
});
