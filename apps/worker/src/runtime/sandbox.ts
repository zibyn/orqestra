import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type TSchema, Type } from "@earendil-works/pi-ai";
import {
	formatSkillsForPrompt,
	type Skill,
} from "@earendil-works/pi-coding-agent";
import type { turnSkills } from "@orqestra/config";
import type { RunHandle } from "@orqestra/conversations";
import {
	type Orrery,
	OrreryError,
	runCommand,
	type SandboxProvider,
	tar,
} from "@orqestra/tools";

/** Where the Skills are written in a Sandbox, one folder each. */
const SKILLS_DIR = "/workspace/.skills";
/** Characters of a command's stdout or stderr the model gets; the start of longer output is cut. */
const MAX_STREAM_CHARS = 20_000;
const MAX_FILE_CHARS = 50_000;

type Skills = ReturnType<typeof turnSkills>;
export type SkillFiles = (
	versionId: number,
) => Promise<{ path: string; content: Uint8Array }[]>;

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

const tail = (s: string) =>
	s.length > MAX_STREAM_CHARS
		? `[The first ${s.length - MAX_STREAM_CHARS} characters were cut off.]\n${s.slice(-MAX_STREAM_CHARS)}`
		: s;

/**
 * The Tools that read files and run commands in the Conversation's Sandbox. The Sandbox is got ready on the
 * first call, and the Skills written into it then, and again whenever it had to be created or started.
 */
export function sandboxTools(
	run: RunHandle,
	provider: SandboxProvider,
	skills: Skills,
	{
		orrery,
		skillFiles,
	}: { orrery: (p: SandboxProvider) => Orrery; skillFiles: SkillFiles },
): AgentTool[] {
	const client = orrery(provider);
	const signal = run.signal;
	let written = false;
	let queue: Promise<unknown> = Promise.resolve();

	async function writeSkills(id: string) {
		const cleared = await runCommand(
			client,
			id,
			`rm -rf ${SKILLS_DIR} && mkdir -p ${SKILLS_DIR}`,
			{ signal },
		);
		if (cleared.exit !== 0)
			throw new Error(`Could not clear ${SKILLS_DIR}: ${cleared.stderr}`);
		const files = await Promise.all(
			skills.map(async (s) =>
				(await skillFiles(s.versionId)).map((f) => ({
					path: `${s.name}/${f.path}`,
					content: f.content,
				})),
			),
		);
		await client.uploadArchive(id, ".skills", tar(files.flat()), { signal });
	}
	// one at a time, so parallel Tool calls create, start and write once
	const ready = () => {
		const next = queue
			.catch(() => {})
			.then(async () => {
				const { id, woke } = await run.sandbox(client, provider);
				if (woke || !written) {
					await writeSkills(id);
					written = true;
				}
				return id;
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
					description: "Absolute, or relative to /workspace",
				}),
			}),
			execute: async (_id, { path }) => {
				const relative = path.replace(/^\/workspace(\/|$)/, "");
				if (relative.startsWith("/"))
					throw new Error("read reaches only /workspace: use bash elsewhere");
				const id = await ready();
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
			description:
				"Run a bash command in your sandbox, with /workspace as the working directory and internet access. It runs until it ends. Returns its exit code, stdout and stderr.",
			parameters: Type.Object({
				command: Type.String({ description: "The command" }),
			}),
			execute: async (_id, { command }) => {
				const id = await ready();
				const r = await runCommand(client, id, command, { signal }).catch(
					(error) => {
						throw explain(error);
					},
				);
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
	];
}
