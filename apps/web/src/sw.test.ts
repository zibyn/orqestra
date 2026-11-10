import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

type Window = { url: string; focused: boolean; focus?: () => void };

/** Runs public/sw.js against a fake service worker scope with these windows open; returns its handlers and what they did. */
function worker(windows: Window[], script = "/sw.js?locale=en") {
	const handlers: Record<string, (event: unknown) => void> = {};
	const shown: { title: string; options: { body: string } }[] = [];
	const opened: string[] = [];
	const self = {
		location: {
			origin: "https://orq.example",
			href: `https://orq.example${script}`,
		},
		addEventListener: (type: string, h: (e: unknown) => void) => {
			handlers[type] = h;
		},
		clients: {
			matchAll: async () => windows,
			openWindow: async (url: string) => opened.push(url),
		},
		registration: {
			showNotification: async (title: string, options: { body: string }) =>
				shown.push({ title, options }),
		},
	};
	new Function("self", readFileSync("public/sw.js", "utf8"))(self);
	const dispatch = async (type: string, event: object) => {
		let done: Promise<unknown> = Promise.resolve();
		handlers[type]({
			...event,
			waitUntil: (p: Promise<unknown>) => {
				done = p;
			},
		});
		await done;
	};
	const push = (alert: object) =>
		dispatch("push", { data: { json: () => alert } });
	const click = (url: string) =>
		dispatch("notificationclick", {
			notification: { close() {}, data: { url } },
		});
	return { push, click, shown, opened };
}

const alert = { title: "News", status: "question", url: "/c/1" };

test("shows an Alert in the language the app registered it in, Chinese by default", async () => {
	const windows = [{ url: "https://orq.example/c/2", focused: true }];
	const en = worker(windows);
	await en.push({ ...alert, status: "partial" });
	expect(en.shown).toMatchObject([
		{ title: "News", options: { body: "Partly done" } },
	]);
	const zh = worker(windows, "/sw.js");
	await zh.push(alert);
	expect(zh.shown).toMatchObject([
		{ title: "News", options: { body: "等你回复" } },
	]);
});

test("shows none while a focused window shows that page", async () => {
	const sw = worker([{ url: "https://orq.example/c/1", focused: true }]);
	await sw.push(alert);
	expect(sw.shown).toEqual([]);
	const unfocused = worker([
		{ url: "https://orq.example/c/1", focused: false },
	]);
	await unfocused.push(alert);
	expect(unfocused.shown).toHaveLength(1);
});

test("a click focuses the window showing the Alert's page, or opens it", async () => {
	let focused = false;
	const sw = worker([
		{
			url: "https://orq.example/c/1",
			focused: false,
			focus: () => {
				focused = true;
			},
		},
	]);
	await sw.click("/c/1");
	expect(focused).toBe(true);
	await sw.click("/tasks?task=t1");
	expect(sw.opened).toEqual(["https://orq.example/tasks?task=t1"]);
});
