import { createHash } from "node:crypto";
import { posix } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type TSchema, Type } from "@earendil-works/pi-ai";
import {
	formatSkillsForPrompt,
	type Skill,
} from "@earendil-works/pi-coding-agent";
import type { turnSkills } from "@orqestra/agents";
import type { RunHandle } from "@orqestra/conversations";
import { connectionToken, type McpServer } from "@orqestra/mcp";
import { SKILLS_DIR } from "@orqestra/skills/shared";
import {
	type ExecRequest,
	type Fetch,
	type Orrery,
	OrreryError,
	runCommand,
	tar,
	workspacePath,
} from "@orqestra/tools";

/** Characters of a command's stdout or stderr the model gets; the start of longer output is cut. */
const MAX_STREAM_CHARS = 20_000;
const MAX_FILE_CHARS = 50_000;

type Skills = ReturnType<typeof turnSkills>;

/** The Skills block of the system prompt: name, description and location of those the model may invoke. */
export const skillsPrompt = (skills: Skills) =>
	formatSkillsForPrompt(
		skills.map(
			(s) =>
				({
					name: s.name,
					description: s.description,
					filePath: `${SKILLS_DIR}/${s.name}/SKILL.md`,
					baseDir: `${SKILLS_DIR}/${s.name}`,
					disableModelInvocation: s.disableModelInvocation,
				}) as Skill,
		),
	);

/** What the model is told when the Sandbox fails it. */
function explain(error: unknown) {
	if (error instanceof OrreryError)
		return new Error(`The Sandbox Provider refused: ${error.message}`);
	if (error instanceof Error && error.name === "TimeoutError")
		return new Error("The Sandbox Provider did not answer in time");
	if (error instanceof TypeError)
		return new Error(
			`The Sandbox Provider cannot be reached: ${error.message}${error.cause instanceof Error ? `: ${error.cause.message}` : ""}`,
		);
	if (error instanceof Error && error.name !== "AbortError")
		return new Error(`The Sandbox is unavailable: ${error.message}`);
	return error;
}

const text = (t: string) => [{ type: "text" as const, text: t }];
// infers `execute`'s params from `parameters`, then fits the Agent's untyped Tool list
const tool = <T extends TSchema>(t: AgentTool<T>) => t as unknown as AgentTool;

/** Where an Agent's relative paths and commands start: a Subagent's own folder, so the Agents of one tree do not write over one another's files by default. */
export const workdir = (
	run: Pick<RunHandle, "isSubagent" | "conversationId">,
) =>
	run.isSubagent ? `/workspace/subagents/${run.conversationId}` : "/workspace";

/** Under SKILLS_DIR: each written Skill's version, by name. */
const VERSIONS = ".versions.json";

/** `s` as one single-quoted bash word. */
const quote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

/** How long a bash command may run on the Git Host token it is given: one expiring sooner is refreshed first. */
const GIT_TOKEN_MARGIN_MS = 60 * 60_000;

/** By the name of the orrery Secret a User's Git Host token is kept in: the SHA-256 of the token this process last wrote to it. */
const writtenTokens = new Map<string, string>();
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** orrery refused an Exec naming a Secret it does not have: another Sandbox Provider, or it was deleted. */
const missingSecret = (error: unknown) =>
	error instanceof OrreryError &&
	error.code === "invalid_request" &&
	error.detail.startsWith("no such Secret");

type GitHostServer = [string, McpServer & Required<Pick<McpServer, "git">>];

/**
 * What a bash command needs to sign git (and gh, which reads `tokenEnv`) in to each Git Host as the Run's User: their Connection's
 * token, refreshed first when it would expire during the command, kept in an orrery Secret of its own per User and Git Host (written
 * only when it changed) that the Exec reads into `tokenEnv`; and per host a credential helper reading it there. The Exec's request
 * never holds a token. Nothing for a host the User has no usable Connection to.
 */
async function gitCredentials(
	run: Pick<RunHandle, "userId" | "connections" | "signal">,
	gitHosts: GitHostServer[],
	client: Orrery,
	fetch?: Fetch,
): Promise<Pick<ExecRequest, "env" | "secrets">> {
	const { connections, userId, signal } = run;
	if (!connections) return {};
	const signedIn = await Promise.all(
		gitHosts.map(async ([serverId, server]) => {
			const token = await connectionToken(connections, userId, serverId, {
				server,
				fetch,
				marginMs: GIT_TOKEN_MARGIN_MS,
			}).catch((error) => {
				// the command still runs, only not signed in to this host
				console.error(
					`Getting the token of ${userId} for Git Host "${serverId}" failed`,
					error,
				);
				return undefined;
			});
			if (!token) return [];
			const secret = `orq-git-${sha256(`${userId}:${serverId}`).slice(0, 16)}`;
			const hash = sha256(token);
			// shortcut: another process writing an older token after this one wrote a newer one leaves orrery the older; only the next refresh fixes it
			if (writtenTokens.get(secret) !== hash) {
				await client.putSecret(secret, token, { signal });
				writtenTokens.set(secret, hash);
			}
			return [{ ...server.git, secret }];
		}),
	);
	const hosts = signedIn.flat();
	if (!hosts.length) return {};
	return {
		secrets: Object.fromEntries(hosts.map((h) => [h.tokenEnv, h.secret])),
		// git's config from the environment, as `git -c` would set it: no secret in it
		env: {
			GIT_CONFIG_COUNT: String(hosts.length),
			...Object.fromEntries(
				hosts.flatMap((h, i) => [
					[`GIT_CONFIG_KEY_${i}`, `credential.https://${h.host}.helper`],
					[
						`GIT_CONFIG_VALUE_${i}`,
						`!f(){ echo username=${h.username}; echo password=$${h.tokenEnv}; }; f`,
					],
				]),
			),
		},
	};
}

const tail = (s: string) =>
	s.length > MAX_STREAM_CHARS
		? `[The first ${s.length - MAX_STREAM_CHARS} characters were cut off.]\n${s.slice(-MAX_STREAM_CHARS)}`
		: s;

/**
 * The Tools that read files and run commands in the Sandbox of the Conversation's tree. The Sandbox is got ready on the
 * first call, and the Skills written into it then, and again whenever it had to be created or started. bash signs git in to the
 * Git Hosts among `mcpServers` as the Run's User (see gitCredentials); `fetch` reaches their authorization servers.
 */
export function sandboxTools(
	run: RunHandle,
	skills: Skills,
	{
		mcpServers = {},
		fetch,
	}: { mcpServers?: Record<string, McpServer>; fetch?: Fetch } = {},
): AgentTool[] {
	const signal = run.signal;
	const dir = workdir(run);
	const resolve = (path: string) =>
		workspacePath(posix.isAbsolute(path) ? path : `${dir}/${path}`);
	const own = run.isSubagent
		? ` It is your own folder in a sandbox you share with the agent that started you: name the files you leave for it, with their full paths, in your final answer. To change a git repository elsewhere under /workspace, never edit it in place: add a worktree of your own on a branch of your own, as in git -C /workspace/<repo> worktree add ${dir}/<repo> -b <its branch>-<your part>. Commit there and leave pushing to the agent that started you: name that branch in your final answer.`
		: "";
	let written = false;
	let queue: Promise<unknown> = Promise.resolve();
	const gitHosts = Object.entries(mcpServers).filter(
		(e): e is GitHostServer => e[1].auth === "oauth" && !!e[1].git,
	);
	const gitHint = gitHosts.length
		? ` git and gh sign in to ${gitHosts.map(([, s]) => s.git.host).join(", ")} as the user once they connect ${gitHosts.map(([, s]) => s.name).join(", ")} on their Connections page (/connections): when cloning, pushing or gh fails to authenticate there, ask them to connect or reconnect it. Clone a repository to /workspace/<repo> and work there on a branch orqestra/<slug>; never push the default branch. Before committing, set the clone's user.name to the user's login and user.email to <id>+<login>@users.noreply.github.com, both from gh api user, so GitHub links the commits to them. To split a change among subagents, tell each one to add its own worktree of /workspace/<repo> in the folder it starts in, whose path only it knows, on a branch orqestra/<slug>-<its part>, to commit there and to push nothing; then merge their branches into yours. Push your branch, open a pull request with gh pr create and give the user its link.`
		: "";

	// the Sandbox is shared with the other Agents of the Conversation's tree, whose Skills may differ: write only the
	// Skills not there at their version, leaving the others; VERSIONS records each one's version
	async function writeSkills(id: string, client: Orrery) {
		const versions: Record<string, number> = await client
			.readFile(id, `.skills/${VERSIONS}`, { signal })
			.then((bytes) => JSON.parse(new TextDecoder().decode(bytes)))
			.catch((error) => {
				// none yet, or unreadable: write every Skill
				if (error instanceof OrreryError && error.status !== 404) throw error;
				return {};
			});
		const stale = skills.filter((s) => versions[s.name] !== s.versionId);
		if (!stale.length) return;
		const cleared = await runCommand(
			client,
			id,
			`rm -rf ${stale.map((s) => quote(`${SKILLS_DIR}/${s.name}`)).join(" ")} && mkdir -p ${SKILLS_DIR}`,
			{ signal },
		);
		if (cleared.exit !== 0)
			throw new Error(`Could not clear ${SKILLS_DIR}: ${cleared.stderr}`);
		const files = await Promise.all(
			stale.map(async (s) =>
				(await run.skillFiles(s.versionId)).map((f) => ({
					path: `${s.name}/${f.path}`,
					content: f.content,
				})),
			),
		);
		for (const s of stale) versions[s.name] = s.versionId;
		// shortcut: two Runs writing at once may each drop the other's entry, which only makes a later Run write that Skill again
		files.push([
			{
				path: VERSIONS,
				content: Buffer.from(JSON.stringify(versions)),
			},
		]);
		await client.uploadArchive(id, ".skills", tar(files.flat()), { signal });
	}
	// one at a time, so parallel Tool calls create, start and write once
	const ready = () => {
		const next = queue
			.catch(() => {})
			.then(async () => {
				const { id, woke, client } = await run.sandbox();
				if (woke || !written) {
					if (skills.length) await writeSkills(id, client);
					written = true;
				}
				return { id, client };
			});
		queue = next;
		return next.catch((error) => {
			throw explain(error);
		});
	};

	return [
		tool({
			name: "read",
			label: "Read",
			description:
				"Read a text file in your sandbox under /workspace, such as a skill's SKILL.md. Use bash for anything else.",
			parameters: Type.Object({
				path: Type.String({
					description: `Absolute, or relative to ${dir}`,
				}),
			}),
			execute: async (_id, { path }) => {
				const relative = resolve(path);
				if (!relative)
					throw new Error("read reaches only /workspace: use bash elsewhere");
				const { id, client } = await ready();
				const bytes = await client
					.readFile(id, relative, { signal })
					.catch((error) => {
						throw explain(error);
					});
				const content = new TextDecoder().decode(bytes);
				return {
					content: text(
						content.length > MAX_FILE_CHARS
							? `${content.slice(0, MAX_FILE_CHARS)}\n\n[The file was cut off here; read the rest with bash.]`
							: content,
					),
					details: undefined,
				};
			},
		}),
		tool({
			name: "bash",
			label: "Bash",
			description: `Run a bash command in your sandbox, with ${dir} as the working directory and internet access. It runs until it ends. Returns its exit code, stdout and stderr.${gitHint}${own}`,
			parameters: Type.Object({
				command: Type.String({ description: "The command" }),
			}),
			execute: async (_id, { command }) => {
				const { id, client } = await ready();
				const attempt = async () => {
					const git = await gitCredentials(run, gitHosts, client, fetch);
					return runCommand(
						client,
						id,
						run.isSubagent
							? `mkdir -p ${quote(dir)} && cd ${quote(dir)} || exit 1; ${command}`
							: command,
						{ signal, ...git },
					).catch((error) => {
						if (missingSecret(error))
							for (const name of Object.values(git.secrets ?? {}))
								writtenTokens.delete(name);
						throw error;
					});
				};
				// once more after a missing Secret, which is then written again
				const r = await attempt()
					.catch((error) => {
						if (missingSecret(error)) return attempt();
						throw error;
					})
					.catch((error) => {
						throw explain(error);
					});
				const lines = [
					r.exit !== null
						? `Exit code: ${r.exit}`
						: `The command did not exit: ${r.cause}`,
					...(r.truncated
						? ["[The Sandbox dropped part of the output: it was too long.]"]
						: []),
					`<stdout>\n${tail(r.stdout)}\n</stdout>`,
					`<stderr>\n${tail(r.stderr)}\n</stderr>`,
				];
				return { content: text(lines.join("\n")), details: undefined };
			},
		}),
		tool({
			name: "attach",
			label: "Attach",
			description:
				"Attach a file in your sandbox under /workspace to your reply, for the user to download: a copy of it as it is now, so attach it once it is final.",
			parameters: Type.Object({
				path: Type.String({
					description: `An existing file; absolute, or relative to ${dir}`,
				}),
			}),
			execute: async (_id, { path }) => {
				const refused = new Error(
					`${path} is not an existing file under /workspace`,
				);
				const relative = resolve(path);
				if (!relative) throw refused;
				const { id, client } = await ready();
				// resolved, so a symlink cannot lead out of /workspace
				const r = await runCommand(
					client,
					id,
					`f=$(realpath -e -- ${quote(`/workspace/${relative}`)}) && case "$f" in /workspace/?*) ;; *) exit 3;; esac && [ -f "$f" ] && stat -c %s -- "$f" && printf %s "$f"`,
					{ signal },
				).catch((error) => {
					throw explain(error);
				});
				if (r.exit !== 0) throw refused;
				const file = r.stdout.split("\n")[1];
				// copied now: what the Sandbox does with it later is not what the user downloads
				const { body } = await client
					.openFile(id, file.slice("/workspace/".length), { signal })
					.catch((error) => {
						throw explain(error);
					});
				const attachment = {
					path: file,
					...(await run.attach(file.slice(file.lastIndexOf("/") + 1), body)),
				};
				return {
					content: text(
						`Attached ${attachment.path} (${attachment.size} bytes): the user sees it under your reply.`,
					),
					details: { attachment },
				};
			},
		}),
	];
}
