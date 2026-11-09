import {
	config,
	SkillNotFound,
	skillCreateInput,
	skillCurrentInput,
	skillEditInput,
	skillEnabledInput,
} from "@orqestra/config/live";
import { SKILL_ZIP_MAX_BYTES } from "@orqestra/config/shared";
import { Elysia, status } from "elysia";
import { z } from "zod";
import { adminOnly } from "./admin.ts";
import type { SignedIn } from "./app.ts";
import { saved } from "./saved.ts";

/** The whole body, or undefined once more than `limit` bytes have come. */
async function readAtMost(body: ReadableStream<Uint8Array>, limit: number) {
	const chunks: Uint8Array[] = [];
	let size = 0;
	for await (const chunk of body) {
		size += chunk.byteLength;
		if (size > limit) return undefined;
		chunks.push(chunk);
	}
	return new Uint8Array(Buffer.concat(chunks));
}

const tooLarge = () =>
	status(413, { errors: { file: { code: "skill_too_large" } } });

// The path names the Skill; the rest of the package's input is the body
const nameParams = z.object({ name: z.string() });

/** Skills, managed by Admins in the console. */
export const skills = (signedIn: SignedIn) =>
	new Elysia({ prefix: "/skills" })
		.use(signedIn)
		.derive(adminOnly)
		// renamed or deleted since the console loaded it
		.onError(({ error, status }) => {
			if (error instanceof SkillNotFound)
				return status(404, {
					errors: { [error.field]: { code: "not_found" } },
				});
		})
		/** Every Skill with its versions, newest first. */
		.get("", () => config.skills.list())
		// A Skill's zip, the raw body; `?replace=true` once the Admin confirmed adding a version to an existing name.
		// Not parsed, so a Member is refused and a large zip measured before it is read.
		.post(
			"",
			async ({ request, query }) => {
				// refused before reading when it says so; the stream is counted anyway
				if (Number(request.headers.get("content-length")) > SKILL_ZIP_MAX_BYTES)
					return tooLarge();
				if (!request.body)
					return status(422, {
						errors: { file: { code: "skill_zip_invalid" } },
					});
				const zip = await readAtMost(request.body, SKILL_ZIP_MAX_BYTES);
				if (!zip) return tooLarge();
				return saved(await config.skills.upload(zip, query.replace === "true"));
			},
			{ parse: "none", query: z.object({ replace: z.string().optional() }) },
		)
		/** A new Skill whose SKILL.md holds only its name and description. */
		.put(
			"/:name",
			async ({ params, body }) =>
				saved(await config.skills.create(params.name, body.description)),
			{ params: nameParams, body: skillCreateInput.omit({ name: true }) },
		)
		/** A version's files; binary ones without `text`. */
		.get(
			"/versions/:id/files",
			({ params }) => config.skills.files(params.id),
			{ params: z.object({ id: z.coerce.number().int() }) },
		)
		/** Saves the edited files of version `base` as the Skill's new current version. */
		.post(
			"/:name/versions",
			async ({ params, body }) =>
				saved(await config.skills.edit(params.name, body.base, body.files)),
			{ params: nameParams, body: skillEditInput.omit({ name: true }) },
		)
		/** Rolls the Skill back (or forward) to one of its versions. */
		.put(
			"/:name/current",
			async ({ params, body }) => {
				await config.skills.setCurrent(params.name, body.versionId);
			},
			{ params: nameParams, body: skillCurrentInput.omit({ name: true }) },
		)
		.put(
			"/:name/enabled",
			async ({ params, body }) => {
				await config.skills.setEnabled(params.name, body.enabled);
			},
			{ params: nameParams, body: skillEnabledInput.omit({ name: true }) },
		)
		/** Also removes it from every Agent Definition. */
		.delete(
			"/:name",
			async ({ params }) => {
				await config.skills.delete(params.name);
			},
			{ params: nameParams },
		);
