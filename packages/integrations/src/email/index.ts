// Email as an Integration: the app is a mailbox. Orqestra holds an IMAP IDLE connection on its INBOX, takes each mail a person sent
// whose From passes DMARC, and answers by SMTP in the same thread; one sender's thread is one session. Threading by RFC 5322's
// Message-ID, In-Reply-To and References; loops are kept off by RFC 3834's Auto-Submitted, Precedence and RFC 2919's List-Id.
import { setTimeout } from "node:timers/promises";
import { ImapFlow } from "imapflow";
import { authenticate, type DMARCResult, type DNSResolver } from "mailauth";
import { simpleParser } from "mailparser";
import { createTransport, type SendMailOptions } from "nodemailer";
import type { Credentials, SessionEvent, WorkSource } from "../ports.ts";

/** Sends one mail as the installation's account. */
export type Send = (
	credentials: Credentials,
	mail: SendMailOptions,
) => Promise<unknown>;

/** What a reply needs, as `sessionId` carries it: the sender's address, the thread's first Message-ID and its subject. */
type Thread = { to: string; root: string; subject: string };

/** How long to wait before connecting again after the connection dropped. */
const RECONNECT_MS = 10_000;

// RFC 9051 lets a server end an IDLE after 30 minutes, and NATs drop quiet connections sooner
const MAX_IDLE_MS = 5 * 60_000;

const smtp: Send = async (c, mail) => {
	const transport = createTransport({
		host: c.smtpHost,
		port: Number(c.smtpPort),
		// 465 is implicit TLS; any other port is upgraded by STARTTLS when the server offers it
		secure: c.smtpPort === "465",
		auth: { user: c.username, pass: c.password },
	});
	try {
		await transport.sendMail(mail);
	} finally {
		transport.close();
	}
};

const imap = (c: Credentials, verifyOnly = false) =>
	new ImapFlow({
		host: c.imapHost,
		port: Number(c.imapPort),
		secure: c.imapPort === "993",
		auth: { user: c.username, pass: c.password },
		logger: false,
		maxIdleTime: MAX_IDLE_MS,
		// a server tells of new mail only while the client idles, so idle soon after each drain (ImapFlow waits 15 seconds)
		autoIdleDelay: 1000,
		verifyOnly,
	});

/** The subject without the reply and forward prefixes clients stack on it. */
export const baseSubject = (subject: string) =>
	subject.replace(/^(\s*(re|fwd?|回复|答复)\s*[:：])+\s*/i, "").trim();

// the first line of the mail a client quotes under the new part, by the attribution it writes over it
const ATTRIBUTION = /^(On\s.*wrote|在.*写道)\s*[:：]\s*$/i;
const SEPARATOR = /^\s*-{2,}\s*(Original Message|原始邮件)\s*-{2,}\s*$/i;
const OUTLOOK = [
	/^(From|发件人)\s*[:：]/,
	/^(Sent|Date|发送时间|时间|日期)\s*[:：]/,
];

/** What the sender wrote this time: the text above the mail they quoted, without `>` quoted lines. */
export function newPart(text: string): string {
	const lines = text.split(/\r?\n/);
	const cut = lines.findIndex(
		(line, i) =>
			ATTRIBUTION.test(line) ||
			// an attribution wrapped onto a second line
			(/^(On\s|在)/.test(line) &&
				ATTRIBUTION.test(`${line} ${lines[i + 1] ?? ""}`)) ||
			SEPARATOR.test(line) ||
			(OUTLOOK[0].test(line) && OUTLOOK[1].test(lines[i + 1] ?? "")),
	);
	return lines
		.slice(0, cut < 0 ? undefined : cut)
		.filter((line) => !line.startsWith(">"))
		.join("\n")
		.trim();
}

/** The DMARC verdict for a mail as delivered: SPF from the delivering hop, which the mailbox's own server wrote at the top. */
export async function dmarcOf(
	raw: Buffer | string,
	resolver?: DNSResolver,
): Promise<DMARCResult | false> {
	const { dmarc } = await authenticate(raw, {
		trustReceived: true,
		disableArc: true,
		disableBimi: true,
		resolver,
	});
	return dmarc;
}

/**
 * A mail the mailbox `address` received, with its DMARC verdict, as the event it starts or prompts a session with; or why it is not
 * acted on: it is not from one person whose domain vouches for it, or a machine sent it, which must never be answered (a loop).
 */
export async function mailEvent(
	raw: Buffer | string,
	dmarc: DMARCResult | false,
	address: string,
): Promise<SessionEvent | { skip: string }> {
	const mail = await simpleParser(raw, {
		skipImageLinks: true,
		skipTextLinks: true,
	});
	const header = (key: string) =>
		mail.headerLines
			.find((h) => h.key === key)
			?.line.slice(key.length + 1)
			.trim()
			.toLowerCase();
	const senders = mail.from?.value ?? [];
	const sender = senders[0]?.address?.toLowerCase();
	if (senders.length !== 1 || !sender) return { skip: "not from one address" };
	if (sender === address.toLowerCase())
		return { skip: "sent by the mailbox itself" };
	const autoSubmitted = header("auto-submitted")?.split(";")[0].trim();
	if (autoSubmitted && autoSubmitted !== "no")
		return { skip: `Auto-Submitted: ${autoSubmitted}` };
	const precedence = header("precedence");
	if (precedence && ["bulk", "list", "junk"].includes(precedence))
		return { skip: `Precedence: ${precedence}` };
	if (header("list-id")) return { skip: "from a mailing list" };
	if (header("return-path") === "<>") return { skip: "a bounce" };
	const status = dmarc ? dmarc.status : undefined;
	const result = status?.result ?? "none";
	// DMARC passes only when SPF or DKIM aligns with the From domain; that the verdict is for this From's domain is checked too
	if (
		result !== "pass" ||
		status?.header?.from?.toLowerCase() !== sender.split("@")[1]
	)
		return { skip: `DMARC ${result} for ${sender}` };
	const id = mail.messageId;
	if (!id) return { skip: "no Message-ID" };
	const references = [mail.references ?? []].flat();
	const root = references[0] ?? mail.inReplyTo ?? id;
	const thread: Thread = {
		to: sender,
		root,
		subject: baseSubject(mail.subject ?? ""),
	};
	return {
		// a job id may not contain a colon, which a Message-ID may
		id: encodeURIComponent(id),
		sessionId: JSON.stringify(thread),
		action: root === id ? "created" : "prompted",
		from: { id: sender, name: senders[0].name || sender },
		issue: null,
		scope: null,
		shared: false,
		text: newPart(mail.text ?? "") || null,
		stop: false,
	};
}

/** Takes each unseen mail in the open INBOX, oldest first, marking it seen once `onEvent` has it or it is not acted on. */
async function drain(
	client: ImapFlow,
	address: string,
	onEvent: (event: SessionEvent) => Promise<void>,
	resolver: DNSResolver | undefined,
) {
	const unseen = await client.search({ seen: false }, { uid: true });
	for (const uid of unseen || []) {
		const message = await client.fetchOne(
			String(uid),
			{ source: true },
			{ uid: true },
		);
		const source = message ? message.source : undefined;
		if (source) {
			// a mail that cannot be read is skipped, not retried, so it never holds up the ones after it
			const event = await dmarcOf(source, resolver)
				.then((dmarc) => mailEvent(source, dmarc, address))
				.catch((error) => ({ skip: `unreadable: ${error}` }));
			if ("skip" in event)
				console.info(`Email: not acting on mail ${uid}: ${event.skip}`);
			else await onEvent(event);
		}
		await client.messageFlagsAdd(String(uid), ["\\Seen"], { uid: true });
	}
}

/** The email WorkSource, sending by `send` and checking DMARC with `resolver` (DNS by default). */
export function emailSource({
	send = smtp,
	resolver,
}: {
	send?: Send;
	resolver?: DNSResolver;
} = {}): WorkSource {
	const reply = (
		{ address }: Credentials,
		to: string,
		subject: string,
		text: string,
		root?: string,
	) => ({
		from: address,
		to,
		subject,
		text,
		inReplyTo: root,
		references: root,
		// RFC 3834: so the sender's own autoresponder does not answer it
		headers: { "Auto-Submitted": "auto-replied" },
	});
	return {
		kind: "email",
		name: "Email",
		install: {
			mode: "credentials",
			fields: [
				{ name: "address", secret: false },
				{ name: "imapHost", secret: false },
				{ name: "imapPort", secret: false },
				{ name: "smtpHost", secret: false },
				{ name: "smtpPort", secret: false },
				{ name: "username", secret: false },
				{ name: "password", secret: true },
			],
			async workspace({ credentials }) {
				const client = imap(credentials, true);
				await client.connect();
				client.close();
				return credentials.address;
			},
		},
		ingress: {
			mode: "stream",
			async connect(auth, onEvent, signal) {
				while (!signal.aborted) {
					const { credentials } = await auth();
					const client = imap(credentials);
					// new mail, or the connection closing, ends the wait between drains
					let wake = () => {};
					let dirty = true;
					client.on("exists", () => {
						dirty = true;
						wake();
					});
					client.on("close", () => wake());
					// a socket error also fails the command waiting on it, which ends this connection below
					client.on("error", () => {});
					const abort = () => client.close();
					signal.addEventListener("abort", abort, { once: true });
					try {
						await client.connect();
						await client.mailboxOpen("INBOX");
						while (!signal.aborted && client.usable) {
							if (!dirty)
								await new Promise<void>((resolve) => {
									wake = resolve;
								});
							dirty = false;
							if (client.usable)
								await drain(client, credentials.address, onEvent, resolver);
						}
					} catch (error) {
						if (
							(error as { authenticationFailed?: boolean }).authenticationFailed
						)
							throw error;
						if (!signal.aborted)
							console.error(
								`Email: the IMAP connection to ${credentials.imapHost} failed`,
								error,
							);
					} finally {
						signal.removeEventListener("abort", abort);
						client.close();
					}
					await setTimeout(RECONNECT_MS, undefined, { signal }).catch(() => {});
				}
			},
		},
		proof: {
			mode: "private-link",
			async tell({ credentials }, person, body) {
				await send(
					credentials,
					reply(
						credentials,
						person.id,
						"Confirm your address in Orqestra",
						body,
					),
				);
			},
		},
		sharedScopes: "all",

		// a thought would be a mail per step, so only what closes the turn is sent
		async post({ credentials }, sessionId, { type, body }) {
			if (type === "thought") return;
			const thread = JSON.parse(sessionId) as Thread;
			await send(
				credentials,
				reply(
					credentials,
					thread.to,
					`Re: ${thread.subject}`,
					body,
					thread.root,
				),
			);
		},

		firstMessage(event, repo) {
			const { subject } = JSON.parse(event.sessionId) as Thread;
			return [
				`Email from ${event.from?.name} <${event.from?.id}>: ${subject || "(no subject)"}`,
				repo && `Repository: ${repo}`,
				event.text,
			]
				.filter(Boolean)
				.join("\n\n");
		},
	};
}

export const email = emailSource();
