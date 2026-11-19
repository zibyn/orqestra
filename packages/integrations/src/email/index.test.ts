import { readFileSync } from "node:fs";
import type { DMARCResult } from "mailauth";
import { describe, expect, it, vi } from "vitest";
import type { SessionEvent } from "../ports.ts";
import { dmarcOf, emailSource, mailEvent } from "./index.ts";
import { dkim, fakeDns, fakeImap, fakeSmtp } from "./testing.ts";

const MAILBOX = "agent@orqestra.test";
const fixture = (name: string) =>
	readFileSync(new URL(`fixtures/${name}`, import.meta.url), "utf8");
const verdict = (result: string, from: string) =>
	({ domain: from, status: { result, header: { from } } }) as DMARCResult;
const pass = (from = "example.com") => verdict("pass", from);
// a header put on top of a fixture, as a list server or autoresponder adds it
const withHeader = (header: string, raw = fixture("new.eml")) =>
	`${header}\r\n${raw}`;
const parse = (raw: string, dmarc: DMARCResult | false = pass()) =>
	mailEvent(raw, dmarc, MAILBOX);
const event = async (raw: string, dmarc?: DMARCResult) => {
	const result = await parse(raw, dmarc);
	if ("skip" in result) throw new Error(`skipped: ${result.skip}`);
	return result;
};

describe("a mail as a session event", () => {
	it("starts a session with a new mail: the thread is the mail itself, keyed by its sender, root and subject", async () => {
		const e = await event(fixture("new.eml"));
		expect(e).toEqual({
			id: encodeURIComponent("<m1:start@example.com>"),
			sessionId: JSON.stringify({
				to: "alice@example.com",
				root: "<m1:start@example.com>",
				subject: "Fix the login redirect",
			}),
			action: "created",
			from: { id: "alice@example.com", name: "Alice Liu" },
			issue: null,
			scope: null,
			shared: false,
			text: "After signing in, the app sends me back to /login.\nCan you find out why?",
			stop: false,
		} satisfies SessionEvent);
		// a queue's job id may not contain a colon
		expect(e.id).not.toContain(":");
	});

	it("prompts the same session with a reply, by the thread's first Message-ID and its subject without prefixes; only the new part is the text", async () => {
		const first = await event(fixture("new.eml"));
		const reply = await event(fixture("reply.eml"));
		expect(reply.action).toBe("prompted");
		expect(reply.sessionId).toBe(first.sessionId);
		expect(reply.text).toBe("Thanks. Please also check the logout path.");
	});

	it("threads by In-Reply-To when a client sends no References, and reads a Chinese client's quote and subject", async () => {
		const e = await event(fixture("reply-163.eml"), pass("example.cn"));
		expect(e).toMatchObject({
			action: "prompted",
			from: { id: "wangwei@example.cn", name: "王伟" },
			text: "还是失败，日志在下面。",
		});
		expect(JSON.parse(e.sessionId)).toEqual({
			to: "wangwei@example.cn",
			root: "<m0@example.cn>",
			subject: "部署失败",
		});
	});

	it("is another session when another person replies in the thread, and cuts Outlook's quoted original", async () => {
		const alice = await event(fixture("new.eml"));
		const bob = await event(fixture("outlook.eml"));
		expect(bob.sessionId).not.toBe(alice.sessionId);
		expect(JSON.parse(bob.sessionId)).toMatchObject({
			to: "bob@example.com",
			root: "<m1:start@example.com>",
			subject: "Fix the login redirect",
		});
		expect(bob.text).toBe("Seen it on staging too.");
	});

	it("reads an HTML-only mail as its text", async () => {
		const e = await event(fixture("html-only.eml"));
		expect(e.text).toContain("Please summarise the deploy.");
	});

	it("does not act on a mail whose From DMARC does not vouch for", async () => {
		const raw = fixture("new.eml");
		for (const dmarc of [
			verdict("fail", "example.com"),
			verdict("none", "example.com"),
			verdict("temperror", "example.com"),
			false as const,
			// a pass, but for a domain other than its From's
			pass("example.org"),
		])
			expect(await parse(raw, dmarc)).toHaveProperty("skip");
	});

	it("never answers a machine: an autoresponder, bulk or list mail, a bounce, or the mailbox's own mail", async () => {
		const loops = [
			fixture("auto-reply.eml"),
			withHeader("Auto-Submitted: auto-generated"),
			withHeader("Precedence: bulk"),
			withHeader("Precedence: list"),
			withHeader("Precedence: junk"),
			withHeader("List-Id: Team <team.lists.example.com>"),
			withHeader("Return-Path: <>"),
			fixture("new.eml").replace(
				"From: Alice Liu <Alice@Example.com>",
				"From: Agent <Agent@orqestra.test>",
			),
		];
		// each skipped for what it is, though DMARC passes
		for (const raw of loops)
			expect(await parse(raw)).toEqual({
				skip: expect.not.stringMatching(/DMARC/),
			});
		expect(
			(await parse(fixture("auto-reply.eml"))) as { skip: string },
		).toEqual({ skip: "Auto-Submitted: auto-replied" });
		// a person's own mail may say so
		expect(await parse(withHeader("Auto-Submitted: no"))).not.toHaveProperty(
			"skip",
		);
	});
});

describe("the DMARC verdict, by mailauth over DNS", () => {
	it("passes a mail its From's domain signed, and fails one another domain signed as it", async () => {
		const example = dkim("example.com");
		const forger = dkim("evil.test");
		const resolver = fakeDns({ ...example.records, ...forger.records });
		const raw = fixture("new.eml");

		const genuine = await example.sign(raw);
		expect(
			await parse(genuine, await dmarcOf(genuine, resolver)),
		).not.toHaveProperty("skip");

		const forged = await forger.sign(raw);
		expect(await parse(forged, await dmarcOf(forged, resolver))).toEqual({
			skip: "DMARC fail for alice@example.com",
		});
		// no DMARC record at all
		expect(
			await parse(genuine, await dmarcOf(genuine, fakeDns(forger.records))),
		).toEqual({ skip: "DMARC none for alice@example.com" });
	});
});

describe("answering", () => {
	const credentials = {
		address: MAILBOX,
		imapHost: "imap.orqestra.test",
		imapPort: "993",
		smtpHost: "smtp.orqestra.test",
		smtpPort: "465",
		username: MAILBOX,
		password: "s3cret",
	};
	const auth = { token: "", credentials };

	it("replies to the sender alone in the thread, as an automatic reply, its Markdown as plain text", async () => {
		const smtp = fakeSmtp();
		const email = emailSource({ send: smtp.send });
		const { sessionId } = await event(fixture("reply.eml"));
		await email.post(
			auth,
			sessionId,
			{ type: "thought", body: "Reading the code" },
			fetch,
		);
		await email.post(
			auth,
			sessionId,
			{ type: "response", body: "The cookie's **path** is `/api`." },
			fetch,
		);
		expect(smtp.sent).toHaveLength(1);
		const [{ envelope, mail, credentials: as }] = smtp.sent;
		expect(as).toBe(credentials);
		expect(envelope).toEqual({ from: MAILBOX, to: ["alice@example.com"] });
		expect(mail.subject).toBe("Re: Fix the login redirect");
		expect(mail.inReplyTo).toBe("<m1:start@example.com>");
		expect(mail.references).toBe("<m1:start@example.com>");
		expect(mail.headers.get("auto-submitted")).toBe("auto-replied");
		expect(mail.text?.trim()).toBe("The cookie's **path** is `/api`.");
		expect(mail.html).toBe(false);
	});

	it("tells a person a link by a mail to them alone", async () => {
		const smtp = fakeSmtp();
		const email = emailSource({ send: smtp.send });
		if (email.proof.mode !== "private-link") throw new Error("no link");
		await email.proof.tell(
			auth,
			{ id: "alice@example.com", name: "Alice Liu" },
			"Open https://orqestra.test/link/abc while signed in.",
			fetch,
		);
		const [{ envelope, mail }] = smtp.sent;
		expect(envelope.to).toEqual(["alice@example.com"]);
		expect(mail.cc).toBeUndefined();
		expect(mail.headers.get("auto-submitted")).toBe("auto-replied");
		expect(mail.text).toContain("https://orqestra.test/link/abc");
	});

	it("opens a Conversation with who wrote, the subject and the text", async () => {
		const e = await event(fixture("new.eml"));
		expect(emailSource().firstMessage(e, undefined)).toBe(
			"Email from Alice Liu <alice@example.com>: Fix the login redirect\n\nAfter signing in, the app sends me back to /login.\nCan you find out why?",
		);
	});
});

describe("the mailbox over IMAP", () => {
	it("checks the account at install by signing in, naming the workspace by its address; refuses a wrong password", async () => {
		const imap = await fakeImap();
		try {
			const email = emailSource();
			if (email.install.mode !== "credentials") throw new Error("not creds");
			expect(
				await email.install.workspace(
					{ token: "", credentials: imap.credentials },
					fetch,
				),
			).toBe(MAILBOX);
			await expect(
				email.install.workspace(
					{
						token: "",
						credentials: { ...imap.credentials, password: "wrong" },
					},
					fetch,
				),
			).rejects.toThrow();
		} finally {
			await imap.close();
		}
	});

	it("hands each unseen mail to onEvent and only then marks it seen, skips one it does not act on, and hears new mail while idling", async () => {
		const imap = await fakeImap();
		const example = dkim("example.com");
		const email = emailSource({ resolver: fakeDns(example.records) });
		const events: SessionEvent[] = [];
		const abort = new AbortController();
		try {
			imap.deliver(await example.sign(fixture("new.eml")));
			imap.deliver(fixture("auto-reply.eml"));
			const connected =
				email.ingress.mode === "stream" &&
				email.ingress.connect(
					async () => ({ token: "", credentials: imap.credentials }),
					async (e) => {
						// not yet seen: a crash now delivers it again
						expect(
							imap.messages.find((m) =>
								m.raw.includes(decodeURIComponent(e.id)),
							)?.seen,
						).toBe(false);
						events.push(e);
					},
					abort.signal,
				);
			await vi.waitFor(
				() => expect(imap.messages.every((m) => m.seen)).toBe(true),
				{ timeout: 5000 },
			);
			expect(events.map((e) => e.action)).toEqual(["created"]);

			imap.deliver(await example.sign(fixture("reply.eml")));
			await vi.waitFor(() => expect(events).toHaveLength(2), {
				timeout: 10_000,
			});
			expect(events[1]).toMatchObject({
				action: "prompted",
				sessionId: events[0].sessionId,
			});
			await vi.waitFor(() => expect(imap.messages[2].seen).toBe(true));

			abort.abort();
			await connected;
			expect(imap.logins).toBe(1);
		} finally {
			abort.abort();
			await imap.close();
		}
	}, 20_000);

	it("throws when the mailbox refuses the credentials", async () => {
		const imap = await fakeImap();
		try {
			const email = emailSource();
			if (email.ingress.mode !== "stream") throw new Error("no stream");
			await expect(
				email.ingress.connect(
					async () => ({
						token: "",
						credentials: { ...imap.credentials, password: "wrong" },
					}),
					async () => {},
					new AbortController().signal,
				),
			).rejects.toMatchObject({ authenticationFailed: true });
		} finally {
			await imap.close();
		}
	});
});
