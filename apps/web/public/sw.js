// Shows the Alerts the worker pushes: { title, status, url }, nothing more (see docs/design/scheduled-and-background-agents.md §4.6)

// A static file outside the Vite build, so no Paraglide: these copy messages/*.json
// (firing_completed, firing_partial, firing_failed, firing_question, task_state_auto_paused, task_state_finished); change both together
const TEXT = {
	en: {
		completed: "Completed",
		partial: "Partly done",
		failed: "Failed",
		question: "Waiting for your reply",
		auto_paused: "Paused after 3 failed Firings",
		finished: "Finished",
	},
	zh: {
		completed: "完成",
		partial: "部分完成",
		failed: "失败",
		question: "等你回复",
		auto_paused: "连续 3 次失败，已自动暂停",
		finished: "已结束",
	},
};
// the app registers this script with its locale, `/sw.js?locale=en`; Chinese is its default
const text =
	new URL(self.location.href).searchParams.get("locale") === "en"
		? TEXT.en
		: TEXT.zh;

const windows = () =>
	self.clients.matchAll({ type: "window", includeUncontrolled: true });
const absolute = (url) => new URL(url, self.location.origin).href;

self.addEventListener("push", (event) => {
	const alert = event.data?.json();
	if (!alert) return;
	event.waitUntil(
		(async () => {
			// the User is looking at it already
			const url = absolute(alert.url);
			if ((await windows()).some((w) => w.focused && w.url === url)) return;
			await self.registration.showNotification(alert.title || "Orqestra", {
				body: text[alert.status] ?? "",
				tag: alert.url,
				data: { url: alert.url },
			});
		})(),
	);
});

self.addEventListener("notificationclick", (event) => {
	event.notification.close();
	const url = absolute(event.notification.data.url);
	event.waitUntil(
		(async () => {
			const open = (await windows()).find((w) => w.url === url);
			return open ? open.focus() : self.clients.openWindow(url);
		})(),
	);
});
