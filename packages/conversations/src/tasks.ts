import {
	type Limits,
	modelRef,
	type OrqestraConfig,
	resolveThinking,
	resolveTurn,
	type ThinkingLevel,
} from "@orqestra/config";
import { db } from "@orqestra/db";
import {
	conversation,
	firing,
	type Schedule,
	scheduledTask,
} from "@orqestra/db/schema";
import { CronExpressionParser } from "cron-parser";
import { and, count, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import {
	countFiring,
	ensureRun,
	FIRINGS_QUEUE,
	firingFailed,
	queueInput,
	runQueue,
	unschedule,
} from "./runs.ts";

/** A Scheduled Task as the User saves it. */
export type TaskInput = {
	name: string;
	prompt: string;
	agentId: string;
	model: string;
	thinking: ThinkingLevel;
	schedule: Schedule;
	/** ISO; recurring tasks only. */
	endsAt: string | null;
	timeZone: string;
	incognito: boolean;
	alertOnComplete: boolean;
	enabled: boolean;
};

/** A Scheduled Task the User may not save as it stands; `field` and `code` say why, for the api's error body. */
export class TaskError extends Error {
	override name = "TaskError";
	constructor(
		message: string,
		readonly field: string,
		readonly code: string,
	) {
		super(message);
	}
}

/** Intervals of a cron expression checked against the shortest allowed: enough to catch an irregular one such as `0 9,10 * * *`. */
const CRON_INTERVALS_CHECKED = 10;

/** The next `n` Firing times of a recurring schedule after `after`, as BullMQ computes them. */
export function nextFirings(
	schedule: Exclude<Schedule, { kind: "once" }>,
	timeZone: string,
	after: Date,
	n = 1,
) {
	if (schedule.kind === "every") {
		// BullMQ aligns `every` to the epoch
		const every = schedule.seconds * 1000;
		const first = Math.floor(after.getTime() / every) * every + every;
		return Array.from({ length: n }, (_, i) => new Date(first + i * every));
	}
	return CronExpressionParser.parse(schedule.expr, {
		currentDate: after,
		tz: timeZone,
	})
		.take(n)
		.map((d) => d.toDate());
}

/**
 * Throws TaskError unless a schedule may be saved: a valid time zone, a one-time task in the future, an interval
 * (a cron expression's, over its next few Firings) no shorter than the Limits' `minFiringInterval`, and an end in the future.
 */
export function checkSchedule(
	limits: Pick<Limits, "minFiringInterval">,
	{
		schedule,
		endsAt,
		timeZone,
	}: Pick<TaskInput, "schedule" | "endsAt" | "timeZone">,
	now = new Date(),
) {
	try {
		new Intl.DateTimeFormat("en", { timeZone });
	} catch {
		throw new TaskError("Not a time zone", "timeZone", "invalid");
	}
	if (schedule.kind === "once") {
		const at = Date.parse(schedule.at);
		if (Number.isNaN(at))
			throw new TaskError("Not a time", "schedule.at", "invalid");
		if (at <= now.getTime())
			throw new TaskError("That time has passed", "schedule.at", "in_past");
		return;
	}
	let times: Date[];
	try {
		times = nextFirings(
			schedule,
			timeZone,
			now,
			schedule.kind === "cron" ? CRON_INTERVALS_CHECKED + 1 : 2,
		);
	} catch {
		throw new TaskError("Not a cron expression", "schedule.expr", "invalid");
	}
	const shortest = Math.min(
		...times.slice(1).map((t, i) => t.getTime() - times[i].getTime()),
	);
	if (shortest < limits.minFiringInterval * 1000)
		throw new TaskError(
			`Firings must be at least ${limits.minFiringInterval} seconds apart`,
			schedule.kind === "cron" ? "schedule.expr" : "schedule.seconds",
			"too_frequent",
		);
	if (endsAt !== null) {
		const ends = Date.parse(endsAt);
		if (Number.isNaN(ends))
			throw new TaskError("Not a time", "endsAt", "invalid");
		if (ends <= now.getTime())
			throw new TaskError("That time has passed", "endsAt", "in_past");
	}
}

/** Throws TaskError unless the User can pick the Agent, and the Model and thinking level are among those it offers. */
function checkTurn(
	cfg: OrqestraConfig,
	{
		agentId,
		model,
		thinking,
	}: Pick<TaskInput, "agentId" | "model" | "thinking">,
) {
	const turn = resolveTurn(cfg, agentId);
	if (!turn?.agent.pickable)
		throw new TaskError(
			"This Agent cannot be picked",
			"agentId",
			"agent_not_pickable",
		);
	const picked = cfg.models.find((m) => modelRef(m) === model);
	if (!picked || !turn.agent.models.includes(model))
		throw new TaskError(
			"This Agent does not offer this Model",
			"model",
			"model_unavailable",
		);
	if (!resolveThinking(turn.agent.thinking, picked).allowed.includes(thinking))
		throw new TaskError(
			"This Model does not offer this thinking level",
			"thinking",
			"thinking_unavailable",
		);
}

type Task = typeof scheduledTask.$inferSelect;

/** The job id of a one-time task's Firing; a recurring one's are `repeat:<task id>:<time>`, BullMQ's. */
const onceJob = (id: string, at: string) => `task:${id}:${Date.parse(at)}`;

/** Makes the firings queue match the task: its scheduler or delayed job while it is active, none otherwise. */
async function schedule(task: Task) {
	const queue = runQueue(FIRINGS_QUEUE);
	const s = task.schedule;
	if (task.state !== "active" || s.kind === "once")
		await queue.removeJobScheduler(task.id);
	if (task.state !== "active") return;
	const opts = { removeOnComplete: true, removeOnFail: 1000 };
	if (s.kind === "once")
		await queue.add(
			"fire",
			{ taskId: task.id },
			{
				...opts,
				jobId: onceJob(task.id, s.at),
				delay: Math.max(0, Date.parse(s.at) - Date.now()),
			},
		);
	else
		await queue.upsertJobScheduler(
			task.id,
			s.kind === "every"
				? { every: s.seconds * 1000 }
				: { pattern: s.expr, tz: task.timeZone },
			{ name: "fire", data: { taskId: task.id }, opts },
		);
}

/** When the task fires next; null when it will not. */
function nextOf(task: Task, now = new Date()) {
	if (task.state !== "active") return null;
	const s = task.schedule;
	if (s.kind === "once") return new Date(s.at);
	const [next] = nextFirings(s, task.timeZone, now);
	return task.endsAt && next > task.endsAt ? null : next;
}

/**
 * One Firing of a task, from the firings queue (job `jobId`): starts a new Conversation with its prompt as the User's message,
 * sent by the task, in an Unattended Run; or records why it was skipped or failed. Under the task's lock.
 * A one-time task, or one whose next Firing is past its end, is finished; one no longer active, or a job its last edit replaced, does nothing.
 */
export async function fire(
	config: () => Promise<OrqestraConfig>,
	taskId: string,
	jobId: string,
) {
	const cfg = await config();
	const now = new Date();
	const { started, stop } = await db.transaction(async (tx) => {
		const [task] = await tx
			.select()
			.from(scheduledTask)
			.where(eq(scheduledTask.id, taskId))
			.for("update");
		const s = task?.schedule;
		const current =
			s?.kind === "once"
				? jobId === onceJob(task.id, s.at)
				: jobId.startsWith(`repeat:${taskId}:`);
		// a scheduler left behind by a delete or pause that failed to remove it goes now
		if (!task || task.state !== "active")
			return { stop: jobId.startsWith(`repeat:${taskId}:`) };
		if (!current) return {};
		const finish = async () => {
			await tx
				.update(scheduledTask)
				.set({ state: "finished" })
				.where(eq(scheduledTask.id, taskId));
			return true;
		};
		if (task.endsAt && task.endsAt <= now) return { stop: await finish() };
		const record = (values: Omit<typeof firing.$inferInsert, "taskId">) =>
			tx.insert(firing).values({ taskId, firedAt: now, ...values });
		// a Conversation waiting on a Question is idle, so not running
		const [previous] = await tx
			.select({ status: conversation.status })
			.from(firing)
			.innerJoin(conversation, eq(conversation.id, firing.conversationId))
			.where(and(eq(firing.taskId, taskId), isNotNull(firing.conversationId)))
			.orderBy(desc(firing.id))
			.limit(1);
		if (previous?.status === "running") {
			await record({ outcome: "skipped", reason: "previous_running" });
			return {};
		}
		const turn = resolveTurn(cfg, task.agentId);
		const reason = !turn?.agent.pickable
			? "agent_unavailable"
			: !turn.agent.models.includes(task.model)
				? "model_disabled"
				: undefined;
		if (reason) {
			await record({ outcome: "failed", reason });
			return { stop: await countFiring(tx, taskId, true) };
		}
		const [{ id }] = await tx
			.insert(conversation)
			.values({
				userId: task.userId,
				agentId: task.agentId,
				incognito: task.incognito,
				scheduledTaskId: taskId,
			})
			.returning({ id: conversation.id });
		// the new Conversation's row is this transaction's alone: no root to lock
		await queueInput(tx, {
			conversationId: id,
			message: { role: "user", content: task.prompt, timestamp: Date.now() },
			model: task.model,
			thinkingLevel: task.thinkingLevel,
			origin: "task",
		});
		await record({ outcome: "running", conversationId: id });
		const last = s?.kind === "once" || !nextOf(task, now);
		return { started: id, stop: last && (await finish()) };
	});
	if (stop) await unschedule(taskId);
	if (started)
		await ensureRun(started).catch(async (error) => {
			console.error(`could not start the Run of Firing ${started}`, error);
			await firingFailed(started);
		});
}

/** The User's Scheduled Tasks: only their own, Admins included. */
export function tasksOf(config: () => Promise<OrqestraConfig>) {
	const owned = (userId: string, id: string) =>
		db.query.scheduledTask.findFirst({
			where: and(eq(scheduledTask.id, id), eq(scheduledTask.userId, userId)),
		});

	async function check(input: TaskInput) {
		const cfg = await config();
		checkTurn(cfg, input);
		checkSchedule(cfg.limits, input);
		return cfg;
	}

	const values = (input: TaskInput) => ({
		name: input.name,
		prompt: input.prompt,
		agentId: input.agentId,
		model: input.model,
		thinkingLevel: input.thinking,
		schedule: input.schedule,
		endsAt:
			input.schedule.kind === "once" || !input.endsAt
				? null
				: new Date(input.endsAt),
		timeZone: input.timeZone,
		incognito: input.incognito,
		alertOnComplete: input.alertOnComplete,
		state: input.enabled ? ("active" as const) : ("paused" as const),
		// a save starts the count afresh, re-enabling an auto-paused task included
		consecutiveFailures: 0,
	});

	const view = (task: Task) => ({
		id: task.id,
		name: task.name,
		prompt: task.prompt,
		agentId: task.agentId,
		model: task.model,
		thinking: task.thinkingLevel as ThinkingLevel,
		schedule: task.schedule,
		endsAt: task.endsAt,
		timeZone: task.timeZone,
		incognito: task.incognito,
		alertOnComplete: task.alertOnComplete,
		state: task.state,
		next: nextOf(task),
	});

	return {
		/** The User's tasks, newest first, each with its latest Firing and the Conversations of its latest Firings. */
		async list(userId: string) {
			const tasks = await db
				.select()
				.from(scheduledTask)
				.where(eq(scheduledTask.userId, userId))
				.orderBy(desc(scheduledTask.createdAt));
			const firings = tasks.length
				? await db
						.select({
							taskId: firing.taskId,
							firedAt: firing.firedAt,
							outcome: firing.outcome,
							conversationId: firing.conversationId,
							title: conversation.title,
							status: conversation.status,
							unread: conversation.unread,
							awaitingReply: conversation.awaitingReply,
						})
						.from(firing)
						.leftJoin(conversation, eq(conversation.id, firing.conversationId))
						.where(
							inArray(
								firing.taskId,
								tasks.map((t) => t.id),
							),
						)
						.orderBy(desc(firing.id))
				: [];
			return tasks.map((task) => {
				const own = firings.filter((f) => f.taskId === task.id);
				return {
					...view(task),
					last: own[0]
						? { firedAt: own[0].firedAt, outcome: own[0].outcome }
						: null,
					// shortcut: every Firing is read to pick these; page them if tasks pile up thousands
					conversations: own
						.filter((f) => f.conversationId)
						.slice(0, 5)
						.map((f) => ({
							id: f.conversationId as string,
							title: f.title,
							firedAt: f.firedAt,
							status: f.status,
							unread: !!f.unread,
							awaitingReply: !!f.awaitingReply,
						})),
				};
			});
		},

		/** A task with all its Firings, newest first; undefined when it is not the User's. */
		async get(userId: string, id: string) {
			const task = await owned(userId, id);
			if (!task) return undefined;
			const firings = await db
				.select({
					id: firing.id,
					firedAt: firing.firedAt,
					outcome: firing.outcome,
					reason: firing.reason,
					conversationId: firing.conversationId,
					title: conversation.title,
					unread: conversation.unread,
				})
				.from(firing)
				.leftJoin(conversation, eq(conversation.id, firing.conversationId))
				.where(eq(firing.taskId, id))
				.orderBy(desc(firing.id));
			return { ...view(task), firings };
		},

		/** Saves a new task and schedules it; throws TaskError when it may not be saved, or the User has the Limits' most. */
		async create(userId: string, input: TaskInput) {
			const cfg = await check(input);
			const task = await db.transaction(async (tx) => {
				// one User's creates queue up here, so two cannot both pass the count
				await tx.execute(
					sql`select pg_advisory_xact_lock(hashtext(${`scheduled_task:${userId}`}))`,
				);
				const [{ n }] = await tx
					.select({ n: count() })
					.from(scheduledTask)
					.where(eq(scheduledTask.userId, userId));
				if (n >= cfg.limits.maxScheduledTasksPerUser)
					throw new TaskError(
						`At most ${cfg.limits.maxScheduledTasksPerUser} Scheduled Tasks`,
						"",
						"too_many",
					);
				const [task] = await tx
					.insert(scheduledTask)
					.values({ userId, ...values(input) })
					.returning();
				return task;
			});
			await schedule(task);
			return task.id;
		},

		/** Saves the task anew, from its next Firing on; false when it is not the User's. */
		async update(userId: string, id: string, input: TaskInput) {
			await check(input);
			const [task] = await db
				.update(scheduledTask)
				.set(values(input))
				.where(and(eq(scheduledTask.id, id), eq(scheduledTask.userId, userId)))
				.returning();
			if (!task) return false;
			await schedule(task);
			return true;
		},

		/** Pauses the task, or enables it again, checked as a save is; false when it is not the User's. */
		async setEnabled(userId: string, id: string, enabled: boolean) {
			const task = await owned(userId, id);
			if (!task) return false;
			if (enabled)
				await check({
					...view(task),
					endsAt: task.endsAt?.toISOString() ?? null,
					enabled,
				});
			const [saved] = await db
				.update(scheduledTask)
				.set(
					enabled
						? { state: "active", consecutiveFailures: 0 }
						: { state: "paused" },
				)
				.where(eq(scheduledTask.id, id))
				.returning();
			await schedule(saved);
			return true;
		},

		/** Deletes the task and its Firings; the Conversations they started become ordinary ones. False when it is not the User's. */
		async delete(userId: string, id: string) {
			const deleted = await db.transaction(async (tx) => {
				// the Conversations first, in the order a Run's end locks them and then the task
				await tx
					.update(conversation)
					.set({ scheduledTaskId: null })
					.where(
						and(
							eq(conversation.scheduledTaskId, id),
							eq(conversation.userId, userId),
						),
					);
				return tx
					.delete(scheduledTask)
					.where(
						and(eq(scheduledTask.id, id), eq(scheduledTask.userId, userId)),
					)
					.returning({ id: scheduledTask.id });
			});
			if (!deleted.length) return false;
			await unschedule(id);
			return true;
		},
	};
}
