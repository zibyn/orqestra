import { describe, expect, it } from "bun:test";
import { limiter } from "./tools.ts";

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
