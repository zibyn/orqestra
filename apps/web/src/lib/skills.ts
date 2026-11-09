import {
	config,
	skillCurrentInput,
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

/** FormData with the zip as `file`, and `replace` once the Admin confirmed adding a version to an existing name. */
export const uploadSkill = createServerFn({ method: "POST" })
	.validator((data: unknown) => {
		if (!(data instanceof FormData)) throw new Error("Expected FormData");
		const file = data.get("file");
		if (!(file instanceof File)) throw new Error("Expected a zip file");
		return { file, replace: data.get("replace") === "true" };
	})
	.handler(async ({ data }) => {
		await requireAdmin();
		return config.skills.upload(
			new Uint8Array(await data.file.arrayBuffer()),
			data.replace,
		);
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
