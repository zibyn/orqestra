// What each kind of outside system offers Orqestra, which the capability packages type against (ADR 0018); each adapter directory
// implements one of these for its system. Clients only: no capability's rules.

import type { IntegrationKind } from "@orqestra/db/schema";

export type { IntegrationKind };

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

/** An Integration Session started (`created`: the app was delegated an issue or mentioned) or prompted again, as the worker acts on it. */
export type SessionEvent = {
	/** One per session start or prompt: a redelivery is the same job. */
	id: string;
	sessionId: string;
	action: "created" | "prompted";
	/** Who started the session, or wrote the prompt; null for a session no person started. */
	from: { email: string; name: string } | null;
	issue: {
		identifier: string;
		title: string;
		description: string | null;
		url: string;
		teamKey: string;
	} | null;
	/** The comment that mentioned the app, or the prompt. */
	text: string | null;
	/** The prompt asks the agent to stop. */
	stop: boolean;
};

/**
 * What the app posts into a session as itself, its body Markdown: a thought, shown as the agent at work; a response, which completes
 * the turn; an elicitation, which waits for the person's answer; or an error.
 */
export type Activity = {
	type: "thought" | "response" | "elicitation" | "error";
	body: string;
};

/**
 * A system where people hand work to Orqestra's app (Linear): it installs the app by OAuth, pushes sessions in by webhook, and takes
 * the app's activities back. Each kind's directory implements it; the Integration Installation and Integration Session are generic.
 */
export interface WorkSource {
	kind: IntegrationKind;
	/** The tool's name, as messages and logs say it. */
	name: string;
	/** Its OAuth authorization endpoint, with the scope and any further parameters it asks for. */
	authorize: { url: string; scope: string; params?: Record<string, string> };
	/** Its OAuth token endpoint, which takes a form (RFC 6749). */
	tokenUrl: string;
	/** The name of the workspace an access token is for. */
	workspace(accessToken: string, fetch: Fetch): Promise<string>;
	/**
	 * A webhook request's event, when the webhook secret signed it and it is fresh at `now`: undefined otherwise, null for a genuine one
	 * Orqestra does not act on.
	 */
	event(
		rawBody: string,
		headers: Headers,
		webhookSecret: string,
		now: number,
	): SessionEvent | null | undefined;
	/** Posts an activity into a session as the app, its body cut to what the tool takes. */
	post(
		accessToken: string,
		sessionId: string,
		activity: Activity,
		fetch: Fetch,
	): Promise<void>;
	/** The first message of the Conversation a session opens, `repo` the repository its issue's team works in. */
	firstMessage(event: SessionEvent, repo: string | undefined): string;
}
