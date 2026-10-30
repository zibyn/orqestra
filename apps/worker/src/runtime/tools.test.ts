import { describe, expect, it } from "bun:test";
import { BudgetExceeded, NoSuchSubagent } from "@orqestra/conversations";
import { subagentTools } from "./tools.ts";

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
