import { thinkingLevel } from "@orqestra/config/shared";
import { type Conversations, TaskError } from "@orqestra/conversations";
import { Elysia } from "elysia";
import { z } from "zod";
import { signedInOnly } from "./admin.ts";
import type { SignedIn } from "./app.ts";

const idParams = z.object({ id: z.uuid() });
const notFound = { errors: { task: { code: "not_found" } } } as const;

const taskInput = z.object({
	name: z.string().trim().min(1).max(100),
	prompt: z.string().trim().min(1).max(20_000),
	agentId: z.string(),
	model: z.string(),
	thinking: thinkingLevel,
	schedule: z.discriminatedUnion("kind", [
		z.object({ kind: z.literal("once"), at: z.iso.datetime({ offset: true }) }),
		z.object({ kind: z.literal("every"), seconds: z.int().positive() }),
		z.object({ kind: z.literal("cron"), expr: z.string().trim().min(1) }),
	]),
	endsAt: z.iso.datetime({ offset: true }).nullable(),
	timeZone: z.string().min(1),
	incognito: z.boolean(),
	alertOnComplete: z.boolean(),
	enabled: z.boolean(),
});

/** /api/scheduled-tasks: the signed-in User's own Scheduled Tasks; another User's, Admins included, read as not found. */
export const scheduledTaskRoutes = (
	signedIn: SignedIn,
	conversations: Conversations,
) => {
	const tasks = conversations.tasks;
	return (
		new Elysia({ prefix: "/scheduled-tasks" })
			.use(signedIn)
			.derive(signedInOnly)
			.onError(({ error, status }) => {
				if (error instanceof TaskError)
					return status(422, {
						errors: { [error.field]: { code: error.code } },
					});
			})
			.get("", ({ user }) => tasks.list(user.id))
			.post(
				"",
				async ({ user, body }) => ({ id: await tasks.create(user.id, body) }),
				{ body: taskInput },
			)
			.get(
				"/:id",
				async ({ user, params, status }) =>
					(await tasks.get(user.id, params.id)) ?? status(404, notFound),
				{ params: idParams },
			)
			.put(
				"/:id",
				async ({ user, params, body, status }) => {
					if (!(await tasks.update(user.id, params.id, body)))
						return status(404, notFound);
				},
				{ params: idParams, body: taskInput },
			)
			/** Pauses the task, or enables it again. */
			.put(
				"/:id/enabled",
				async ({ user, params, body, status }) => {
					if (!(await tasks.setEnabled(user.id, params.id, body.enabled)))
						return status(404, notFound);
				},
				{ params: idParams, body: z.object({ enabled: z.boolean() }) },
			)
			.delete(
				"/:id",
				async ({ user, params, status }) => {
					if (!(await tasks.delete(user.id, params.id)))
						return status(404, notFound);
				},
				{ params: idParams },
			)
	);
};
