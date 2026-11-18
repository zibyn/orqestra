// What each kind of outside system offers Orqestra, which the capability packages type against (ADR 0018); each adapter directory
// implements one of these for its system. Clients only: no capability's rules.

export type Fetch = (
	input: string | URL,
	init?: RequestInit,
) => Promise<Response>;

export interface SearchResult {
	title: string;
	url: string;
	snippet: string;
}

/** A Search Provider (tavily, firecrawl, deepseek): only the parameters all of them share. */
export interface SearchClient {
	search(
		query: string,
		count: number,
		signal?: AbortSignal,
	): Promise<SearchResult[]>;
	/** One page as Markdown; throws when it has none. */
	scrape(url: string, signal?: AbortSignal): Promise<string>;
}

/** A Document Parser (mineru): a document turned into Markdown. */
export interface ParserClient {
	/** The file's Markdown, polling until the parser is done or `signal` aborts; `pages` like "1-10" or "2,4-6", all by default. */
	parse(
		file: { name: string; bytes: Uint8Array<ArrayBuffer>; pages?: string },
		signal: AbortSignal,
	): Promise<string>;
}

export type SandboxState =
	| "pending"
	| "provisioning"
	| "ready"
	| "stopping"
	| "stopped"
	| "deleting"
	| "deleted"
	| "failed";

/** The fields Orqestra reads; orrery sends more. */
export interface Sandbox {
	id: string;
	state: SandboxState;
	/** Why it stopped or failed, e.g. `quota_exceeded`, `runtime_lost`. */
	cause: string | null;
}

export interface CreateSandbox {
	name?: string;
	labels?: Record<string, string>;
	snapshot?: string;
	cpu: number;
	memory: number;
	/** Seconds idle before orrery stops it; 0 never. orrery's default is 900. */
	idle_stop?: number;
}

export interface ExecRequest {
	/** Not run through a shell. */
	argv: string[];
	env?: Record<string, string>;
	/** ENV_NAME to the name of a Secret of the Sandbox's owner; orrery resolves it, so the value is never sent here. */
	secrets?: Record<string, string>;
	/** Relative to /workspace. */
	cwd?: string;
	/** Seconds; omitted means no limit. */
	timeout?: number;
	/** Written once, then closed. */
	stdin?: string;
}

export interface Exec {
	id: string;
	state: "pending" | "running" | "canceling" | "finished";
	/** Set once finished; `cause` is `exited`, `canceled`, `timed_out`, `oom_killed`, `start_failed`, … */
	result: { cause: string; exit_code?: number; signal?: number } | null;
	log_truncated: boolean;
}

/** One frame of an Exec's output; `data` is base64 when `encoding` says so (invalid UTF-8). */
export interface Frame {
	seq: number;
	stream: "stdout" | "stderr" | "truncated";
	data: string;
	encoding?: "base64";
}

type Opts = { signal?: AbortSignal };

/** The Sandbox Provider (orrery, docs/spec/api.md §3–§5): Sandboxes, the commands run in them, and their Workspace files. */
export interface SandboxClient {
	/** The User the API Token belongs to. */
	me(o?: Opts): Promise<{ id: string; name: string }>;
	/** Creates or overwrites a Secret of the API Token's User; orrery never gives its value back. */
	putSecret(name: string, value: string, o?: Opts): Promise<void>;

	/** Returns it `pending`; with no `workspace` orrery makes a temporary one, deleted with it. */
	createSandbox(request: CreateSandbox, o?: Opts): Promise<Sandbox>;
	/** `waitFor` long-polls up to 60 seconds, then answers the current state. */
	getSandbox(
		sandbox: string,
		o?: Opts & { waitFor?: SandboxState },
	): Promise<Sandbox>;
	/** Back to `pending`; its Workspace files are kept. */
	startSandbox(sandbox: string, o?: Opts): Promise<Sandbox>;
	/** Cancels its Execs, then deletes it with its temporary Workspace. */
	deleteSandbox(sandbox: string, o?: Opts): Promise<Sandbox>;

	/** Fails with `conflict` unless the Sandbox is `ready`. */
	createExec(sandbox: string, request: ExecRequest, o?: Opts): Promise<Exec>;
	getExec(exec: string, o?: Opts): Promise<Exec>;
	cancelExec(exec: string, o?: Opts): Promise<Exec>;
	/** One page of output past `after` (0: from the start; next: `frameEnd` of the last frame); empty once caught up. */
	execOutput(exec: string, after?: number, o?: Opts): Promise<Frame[]>;

	// Workspace files: `path` is relative to /workspace; the Sandbox must be `ready`
	/** A directory's entries; `not_found` when it does not exist. */
	listFiles(
		sandbox: string,
		path: string,
		o?: Opts,
	): Promise<{ name: string; type: string }[]>;
	readFile(
		sandbox: string,
		path: string,
		o?: Opts,
	): Promise<Uint8Array<ArrayBuffer>>;
	/** A file's bytes as they arrive, and its size when orrery sends one: for files too large to hold in memory. */
	openFile(
		sandbox: string,
		path: string,
		o?: Opts,
	): Promise<{ body: ReadableStream<Uint8Array>; size: number | undefined }>;
	/** Written to a temporary file, then renamed over `path`; one that fails midway leaves nothing. `data` is bytes, or a stream sent as it is read. */
	writeFile(
		sandbox: string,
		path: string,
		data: Uint8Array<ArrayBuffer> | ReadableStream<Uint8Array>,
		o?: Opts,
	): Promise<void>;
	/** Unpacks a tar into `path`. */
	uploadArchive(
		sandbox: string,
		path: string,
		tar: Uint8Array<ArrayBuffer>,
		o?: Opts,
	): Promise<void>;
}

// WorkSource: added by the Linear move
