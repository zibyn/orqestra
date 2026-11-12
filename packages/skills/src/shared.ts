// No Node imports: browser code can use this module (as @orqestra/skills/shared)

/** The largest Skill zip an Admin can upload: 10 MB of files unzipped, stored as they are, plus room for the zip's headers. */
export const SKILL_ZIP_MAX_BYTES = 12 * 1024 * 1024;

/** Why a Skill save was refused, as a code the console translates. */
export type SkillError =
	| {
			code:
				| "not_found"
				| "skill_zip_invalid"
				| "skill_md_missing"
				| "skill_frontmatter_invalid"
				| "skill_name_invalid"
				| "skill_description_invalid"
				| "skill_too_large"
				| "skill_too_many_files"
				| "skill_exists";
	  }
	| {
			code:
				| "skill_path_unsafe"
				| "skill_symlink"
				| "skill_path_duplicate"
				| "skill_md_nested"
				| "skill_file_binary";
			path: string;
	  }
	| { code: "skill_name_mismatch"; name: string; folder: string };

/** Field errors by name (`file`, `name`, `description`); empty when it was saved. */
export type SkillErrors = Record<string, SkillError>;

/** One of a Skill version's files, its path relative to the Skill's folder (`SKILL.md`, `scripts/…`). */
export type SkillFile = { path: string; content: Uint8Array };

/** Where a Sandbox holds its Skills, one folder each. */
export const SKILLS_DIR = "/workspace/.skills";

/** What a User's message that invokes a Skill becomes: its instructions, then what the User wrote, as pi expands `/skill:name args`. */
export function skillBlock(name: string, body: string, args: string) {
	const block = `<skill name="${name}" location="${SKILLS_DIR}/${name}/SKILL.md">\nReferences are relative to ${SKILLS_DIR}/${name}.\n\n${body}\n</skill>`;
	return args ? `${block}\n\n${args}` : block;
}

/** The Skill a User's text invokes as `/skill:name args`, and the args; undefined when it invokes none. */
export function invokedSkill(text: string) {
	const match = text.match(/^\/skill:(\S+)\s*([\s\S]*)$/);
	return match ? { name: match[1], args: match[2].trim() } : undefined;
}

/** The Skill a User's message invoked and what they wrote with it; undefined when it invokes none. */
export function parseSkillBlock(text: string) {
	// pi's parseSkillBlock pattern
	const match = text.match(
		/^<skill name="([^"]+)" location="[^"]+">\n[\s\S]*?\n<\/skill>(?:\n\n([\s\S]+))?$/,
	);
	return match ? { name: match[1], text: match[2]?.trim() ?? "" } : undefined;
}
