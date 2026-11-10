import { describe, expect, it } from "bun:test";
import { BudgetExceeded, NoSuchSubagent } from "@orqestra/conversations";
import { draftTool, subagentTools } from "./tools.ts";

describe("subagentTools", () => {
	const refusing = (error: Error) => {
		const refuse = async () => {
			throw error;
		};
		return subagentTools({ agents: [] } as never, {
			start: refuse,
			message: refuse,
			stop: refuse,
		});
	};

	it("tells the model how much of its budget is spent when it refuses more Subagents", async () => {
		const [spawn] = refusing(new BudgetExceeded(15));
		await expect(
			spawn.execute("call", { tasks: [{ brief: "b" }, { brief: "c" }] }),
		).rejects.toThrow(
			"Since the user's last message at most 16 subagents may be started or continued, and 15 have been: do the rest of the work yourself.",
		);
	});

	it("tells the model which Subagent does not exist", async () => {
		const [, message, stop] = refusing(new NoSuchSubagent(3));
		await expect(
			message.execute("call", { number: 3, message: "m" }),
		).rejects.toThrow("There is no subagent 3");
		await expect(stop.execute("call", { numbers: [3] })).rejects.toThrow(
			"There is no subagent 3",
		);
	});
});

describe("draftTool", () => {
	const draft = draftTool({ minFiringInterval: 60 });
	const args = (schedule: object, ends_at?: string) =>
		({ name: "n", prompt: "p", schedule, ends_at }) as never;

	it("refuses a time without its UTC offset, which would be read in the worker's time zone", async () => {
		await expect(
			draft.execute("call", args({ kind: "once", at: "2999-01-31T09:00:00" })),
		).rejects.toThrow("schedule.at: give the time with its UTC offset");
		await expect(
			draft.execute(
				"call",
				args({ kind: "every", seconds: 3600 }, "2999-01-31T09:00"),
			),
		).rejects.toThrow("ends_at: give the time with its UTC offset");
	});

	it("drafts a time given with its offset", async () => {
		const result = await draft.execute(
			"call",
			args({ kind: "once", at: "2999-01-31T09:00:00+08:00" }),
		);
		expect(JSON.stringify(result.content)).toContain("shown to the user");
	});
});
