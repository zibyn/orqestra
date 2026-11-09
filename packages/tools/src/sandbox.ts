// Using a Sandbox through the orrery client: getting one ready, and running a command to its end.
import {
	type Frame,
	frameBytes,
	frameEnd,
	type Orrery,
	OrreryError,
	type SandboxProvider,
} from "./orrery.ts";

/**
 * Where a Sandbox's id is kept. Under a lock: answers the stored id, unless there is none or it is `replacing`;
 * then calls `create`, stores what it answers and answers that.
 */
export type ClaimSandbox = (
	replacing: string | null,
	create: () => Promise<string>,
) => Promise<string>;

/** How long a Sandbox may take to become ready, queueing included, before using it fails. */
export const SANDBOX_READY_MS = 5 * 60_000;

/**
 * Gets the Sandbox kept by `claim` ready: creates it the first time (a temporary Workspace, egress open),
 * starts it if Idle Stop stopped it, and creates a new one if it is gone (failed or deleted, its files lost).
 * `woke` says it was just created or started, so files written at start (the Skills) must be written again.
 * Throws an OrreryError, a network error, or an Error saying why it never became ready.
 */
export async function readySandbox(
	client: Orrery,
	provider: SandboxProvider,
	claim: ClaimSandbox,
	{
		signal,
		timeoutMs = SANDBOX_READY_MS,
	}: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<{ id: string; woke: boolean }> {
	const deadline = Date.now() + timeoutMs;
	let fresh = "";
	const create = async () => {
		const { id } = await client.createSandbox(
			{
				cpu: provider.cpu,
				memory: provider.memory,
				...(provider.snapshot && { snapshot: provider.snapshot }),
			},
			{ signal },
		);
		fresh = id;
		return id;
	};
	let id = await claim(null, create);
	let woke = id === fresh;
	for (;;) {
		const sandbox = await client.getSandbox(id, { signal }).catch((error) => {
			if (error instanceof OrreryError && error.code === "not_found")
				return null;
			throw error;
		});
		let state = sandbox?.state;
		while (state === "pending" || state === "stopping" || state === "stopped") {
			if (Date.now() > deadline)
				throw new Error(
					`The Sandbox is still ${state} after ${timeoutMs / 1000} s`,
				);
			if (state === "stopped") {
				await client.startSandbox(id, { signal });
				woke = true;
			}
			const s = await client.getSandbox(id, {
				waitFor: state === "stopping" ? "stopped" : "ready",
				signal,
			});
			state = s.state;
			if (s.state === "failed" && id === fresh)
				throw new Error(`The Sandbox failed to start: ${s.cause}`);
		}
		if (state === "ready") return { id, woke };
		// failed, deleting, deleted or not found: it is gone
		if (id === fresh)
			throw new Error(
				`The new Sandbox is ${state ?? "gone"}: ${sandbox?.cause ?? ""}`,
			);
		const gone = id;
		id = await claim(id, create);
		woke = true;
		// a failed one holds its Workspace until deleted; if this fails, it is left for good
		if (state === "failed")
			await client.deleteSandbox(gone, { signal }).catch(() => {});
	}
}

/** A finished command: `exit` is its code, null when it did not exit (`cause` says why: timed_out, oom_killed, canceled…). */
export interface CommandResult {
	stdout: string;
	stderr: string;
	exit: number | null;
	cause: string;
	/** orrery or this client dropped output past their limits. */
	truncated: boolean;
}

/** Output kept per stream; the rest is dropped (and `truncated` set), so a chatty command cannot fill memory. */
const MAX_STREAM_BYTES = 1024 * 1024;

/**
 * Runs `command` with bash in the ready Sandbox and waits for it to finish, however long it takes, polling its
 * output as orrery's SDKs do. Aborting `signal` cancels it.
 */
export async function runCommand(
	client: Orrery,
	sandbox: string,
	command: string,
	{ signal, pollMs = 100 }: { signal?: AbortSignal; pollMs?: number } = {},
): Promise<CommandResult> {
	const exec = await client.createExec(
		sandbox,
		{ argv: ["bash", "-lc", command] },
		{ signal },
	);
	const out = { stdout: [] as Buffer[], stderr: [] as Buffer[] };
	const size = { stdout: 0, stderr: 0 };
	let truncated = false;
	let after = 0;
	const keep = (frame: Frame) => {
		if (frame.stream === "truncated") {
			truncated = true;
			return;
		}
		const bytes = frameBytes(frame);
		const room = MAX_STREAM_BYTES - size[frame.stream];
		if (bytes.length > room) truncated = true;
		out[frame.stream].push(bytes.subarray(0, Math.max(room, 0)));
		size[frame.stream] += bytes.length;
	};
	try {
		for (;;) {
			const state = await client.getExec(exec.id, { signal });
			// read up to now; once finished, that is all of it
			for (;;) {
				const page = await client.execOutput(exec.id, after, { signal });
				if (!page.length) break;
				page.forEach(keep);
				after = frameEnd(page[page.length - 1]);
			}
			if (state.state === "finished")
				return {
					stdout: Buffer.concat(out.stdout).toString("utf8"),
					stderr: Buffer.concat(out.stderr).toString("utf8"),
					exit: state.result?.exit_code ?? null,
					cause: state.result?.cause ?? "",
					truncated: truncated || state.log_truncated,
				};
			await new Promise((resolve) => setTimeout(resolve, pollMs));
		}
	} catch (error) {
		if (signal?.aborted) await client.cancelExec(exec.id).catch(() => {});
		throw error;
	}
}
