import { db } from "@orqestra/db";
import {
	conversation,
	pushSubscription,
	scheduledTask,
} from "@orqestra/db/schema";
import { and, eq, or, sql } from "drizzle-orm";
import webpush from "web-push";

/** How what an Alert tells of ended: a Run (a Question waits for the User), or a Scheduled Task that paused or finished on its own. */
export type AlertStatus =
	| "completed"
	| "partial"
	| "failed"
	| "question"
	| "auto_paused"
	| "finished";

/** All a push carries, Incognito or not: no reply text. `url` is the page a click opens. */
export type Alert = { title: string; status: AlertStatus; url: string };

/** The VAPID keys from the environment; undefined while any is unset, and then no Alert is sent. */
function vapid() {
	const {
		VAPID_PUBLIC_KEY: publicKey,
		VAPID_PRIVATE_KEY: privateKey,
		VAPID_SUBJECT: subject,
	} = process.env;
	return publicKey && privateKey && subject
		? { publicKey, privateKey, subject }
		: undefined;
}

/** Pushes the Alert to every browser of the User's; one its push service says is gone (404, 410) is dropped. Never throws. */
export async function sendAlert(userId: string, alert: Alert) {
	const vapidDetails = vapid();
	if (!vapidDetails) return;
	try {
		const subs = await db
			.select()
			.from(pushSubscription)
			.where(eq(pushSubscription.userId, userId));
		await Promise.all(
			subs.map((s) =>
				webpush
					.sendNotification(s, JSON.stringify(alert), {
						vapidDetails,
						// a day late is still worth knowing
						TTL: 86_400,
					})
					.catch(async (error: { statusCode?: number }) => {
						if (error.statusCode === 404 || error.statusCode === 410)
							await db
								.delete(pushSubscription)
								.where(eq(pushSubscription.id, s.id));
						else console.error(`could not push an Alert to ${s.id}`, error);
					}),
			),
		);
	} catch (error) {
		console.error("could not send an Alert", error);
	}
}

/** The page a Scheduled Task's Alert opens: its drawer on the tasks page. */
export const taskUrl = (taskId: string) => `/tasks?task=${taskId}`;

/**
 * A top-level Conversation's Run ended as `status`: Alerts its User, unless the Conversation is a Firing's
 * whose task has Alerts off and it ended completed or partial.
 */
export async function alertRun(conversationId: string, status: AlertStatus) {
	const [conv] = await db
		.select({
			userId: conversation.userId,
			title: conversation.title,
			taskName: scheduledTask.name,
			alertOnComplete: scheduledTask.alertOnComplete,
		})
		.from(conversation)
		.leftJoin(scheduledTask, eq(scheduledTask.id, conversation.scheduledTaskId))
		.where(eq(conversation.id, conversationId));
	if (!conv) return;
	if (
		conv.alertOnComplete === false &&
		(status === "completed" || status === "partial")
	)
		return;
	await sendAlert(conv.userId, {
		title: conv.title ?? conv.taskName ?? "",
		status,
		url: `/c/${conversationId}`,
	});
}

/** The browsers that receive a User's Alerts. */
export const alerts = {
	/** The VAPID public key a browser subscribes with; null when Alerts are not configured. */
	publicKey: () => vapid()?.publicKey ?? null,
	/**
	 * This browser receives the User's Alerts, taken from whoever was signed in on it before:
	 * only the browser itself has its keys, so another User's endpoint sent with other keys stays theirs.
	 */
	async subscribe(
		userId: string,
		{
			endpoint,
			keys,
		}: { endpoint: string; keys: { p256dh: string; auth: string } },
	) {
		await db
			.insert(pushSubscription)
			.values({ userId, endpoint, keys })
			.onConflictDoUpdate({
				target: pushSubscription.endpoint,
				set: { userId, keys },
				setWhere: or(
					eq(pushSubscription.userId, userId),
					sql`${pushSubscription.keys} = excluded.keys`,
				),
			});
	},
	/** This browser receives the User's Alerts no more. */
	async unsubscribe(userId: string, endpoint: string) {
		await db
			.delete(pushSubscription)
			.where(
				and(
					eq(pushSubscription.endpoint, endpoint),
					eq(pushSubscription.userId, userId),
				),
			);
	},
};
