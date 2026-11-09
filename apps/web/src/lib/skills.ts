import {
	config,
	skillCreateInput,
	skillCurrentInput,
	skillEditInput,
	skillEnabledInput,
} from "@orqestra/config/live";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireAdmin } from "#/lib/session";

// Skills, managed by Admins in /console/skills.

export const getSkills = createServerFn().handler(async () => {
	await requireAdmin();
	return config.skills.list();
});

export const setSkillEnabled = createServerFn({ method: "POST" })
	.validator(skillEnabledInput)
	.handler(async ({ data }) => {
		await requireAdmin();
		await config.skills.setEnabled(data.name, data.enabled);
	});

/** Rolls the Skill back (or forward) to one of its versions. */
export const setSkillVersion = createServerFn({ method: "POST" })
	.validator(skillCurrentInput)
	.handler(async ({ data }) => {
		await requireAdmin();
		await config.skills.setCurrent(data.name, data.versionId);
	});

/** Also removes it from every Agent Definition. */
export const deleteSkill = createServerFn({ method: "POST" })
	.validator(z.string())
	.handler(async ({ data }) => {
		await requireAdmin();
		await config.skills.delete(data);
	});

/** A new Skill with a SKILL.md holding only its name and description. */
export const createSkill = createServerFn({ method: "POST" })
	.validator(skillCreateInput)
	.handler(async ({ data }) => {
		await requireAdmin();
		return config.skills.create(data.name, data.description);
	});

/** A version's files; binary ones without `text`. */
export const getSkillFiles = createServerFn()
	.validator(z.number().int())
	.handler(async ({ data }) => {
		await requireAdmin();
		return config.skills.files(data);
	});

/** Saves the edited files as the Skill's new current version. */
export const editSkill = createServerFn({ method: "POST" })
	.validator(skillEditInput)
	.handler(async ({ data }) => {
		await requireAdmin();
		return config.skills.edit(data.name, data.base, data.files);
	});
