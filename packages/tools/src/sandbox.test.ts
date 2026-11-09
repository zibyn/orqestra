import { describe, expect, it } from "vitest";
import {
	type ClaimSandbox,
	readySandbox,
	runCommand,
	workspacePath,
} from "./sandbox.ts";
import { memoryOrrery } from "./testing.ts";

const provider = { url: "http://o", token: "t", cpu: 2, memory: 2 * 1024 ** 3 };

/** A Conversation's stored Sandbox id, in memory. */
function stored() {
	const kept = { id: null as string | null };
	const claim: ClaimSandbox = async (replacing, create) => {
		if (!kept.id || kept.id === replacing) kept.id = await create();
		return kept.id;
	};
	return { kept, claim };
}

describe("readySandbox", () => {
	it("creates the Sandbox the first time, waits until ready, and reuses it after", async () => {
		const o = memoryOrrery();
		const { kept, claim } = stored();
		expect(
			await readySandbox(o.client, { ...provider, snapshot: "skills" }, claim),
		).toEqual({
			id: "sb1",
			woke: true,
		});
		expect(kept.id).toBe("sb1");
		expect(o.calls[0]).toBe(
			`createSandbox ${JSON.stringify({ cpu: 2, memory: 2147483648, snapshot: "skills" })}`,
		);
		expect(o.state("sb1")).toBe("ready");

		expect(await readySandbox(o.client, provider, claim)).toEqual({
			id: "sb1",
			woke: false,
		});
		expect(o.calls.filter((c) => c.startsWith("createSandbox"))).toHaveLength(
			1,
		);
	});

	it("starts a Sandbox Idle Stop stopped, keeping its files", async () => {
		const o = memoryOrrery();
		const { claim } = stored();
		await readySandbox(o.client, provider, claim);
		o.files("sb1").set("notes.txt", new Uint8Array([1]));
		o.stop("sb1");

		expect(await readySandbox(o.client, provider, claim)).toEqual({
			id: "sb1",
			woke: true,
		});
		expect(o.calls).toContain("startSandbox sb1");
		expect(o.files("sb1").get("notes.txt")).toEqual(new Uint8Array([1]));
	});

	it("replaces a Sandbox that is gone", async () => {
		const o = memoryOrrery();
		const { kept, claim } = stored();
		await readySandbox(o.client, provider, claim);
		o.fail("sb1");
		expect(await readySandbox(o.client, provider, claim)).toEqual({
			id: "sb2",
			woke: true,
		});
		expect(kept.id).toBe("sb2");
		// a failed one holds its Workspace until deleted
		expect(o.calls).toContain("deleteSandbox sb1");
	});

	it("fails with orrery's error when orrery cannot be reached", async () => {
		const o = memoryOrrery();
		o.down = true;
		await expect(
			readySandbox(o.client, provider, stored().claim),
		).rejects.toThrow("fetch failed");
	});
});

describe("runCommand", () => {
	it("answers the command's stdout, stderr and exit code", async () => {
		const o = memoryOrrery({
			exec: (command) => ({
				stdout: `ran ${command}\n`,
				stderr: "warn\n",
				exit_code: 3,
			}),
		});
		const { id } = await readySandbox(o.client, provider, stored().claim);
		expect(await runCommand(o.client, id, "ls", { pollMs: 1 })).toEqual({
			stdout: "ran ls\n",
			stderr: "warn\n",
			exit: 3,
			cause: "exited",
			truncated: false,
		});
	});

	it("says why a command that did not exit ended", async () => {
		const o = memoryOrrery({ exec: () => ({ cause: "oom_killed" }) });
		const { id } = await readySandbox(o.client, provider, stored().claim);
		expect(await runCommand(o.client, id, "x", { pollMs: 1 })).toMatchObject({
			exit: null,
			cause: "oom_killed",
		});
	});

	it("cancels the command when aborted", async () => {
		const o = memoryOrrery({ exec: () => ({ running: true }) });
		const { id } = await readySandbox(o.client, provider, stored().claim);
		const stop = new AbortController();
		const ran = runCommand(o.client, id, "sleep 1000", {
			signal: stop.signal,
			pollMs: 1,
		});
		await new Promise((resolve) => setTimeout(resolve, 10));
		stop.abort();
		await expect(ran).rejects.toThrow();
		expect(o.calls.filter((c) => c.startsWith("cancelExec"))).toHaveLength(1);
	});
});

describe("workspacePath", () => {
	it("answers a path under /workspace relative to it, and nothing for any other", () => {
		expect(workspacePath("/workspace/out/report.pdf")).toBe("out/report.pdf");
		expect(workspacePath("out//./a/../report.pdf")).toBe("out/report.pdf");
		for (const outside of [
			"/workspace",
			"/workspace/",
			"/etc/passwd",
			"/workspace/../etc/passwd",
			"../etc/passwd",
			"/workspacex/a",
			"a\0b",
			"",
		])
			expect(workspacePath(outside)).toBeUndefined();
	});
});
