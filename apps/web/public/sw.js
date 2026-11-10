// Shows the Alerts the worker pushes: { title, status, url }, nothing more (see docs/design/scheduled-and-background-agents.md §4.6)

const TEXT = {
	en: {
		completed: "Done",
		partial: "Stopped partway",
		failed: "Failed",
		question: "Waiting for your reply",
		auto_paused: "Scheduled Task paused after repeated failures",
		finished: "Scheduled Task finished",
	},
	zh: {
		completed: "已完成",
		partial: "部分完成",
		failed: "失败",
		question: "等你回复",
		auto_paused: "定时任务多次失败，已自动暂停",
		finished: "定时任务已结束",
	},
};

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
			const text = navigator.language.startsWith("zh") ? TEXT.zh : TEXT.en;
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
