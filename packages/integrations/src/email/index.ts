// Email as an Integration: the app is a mailbox. Orqestra watches its INBOX read-only over IMAP IDLE from a cursor of UIDs, as OpenClaw's
// IMAP plugin does, takes each mail a person sent whose From its own domain DKIM-signed, and answers by SMTP in the same thread; one
// sender's thread is one session. Threading by RFC 5322's Message-ID, In-Reply-To and References; loops are kept off as Discourse and
// RFC 3834 do: by Auto-Submitted, Precedence, List-Id, the autoresponders' own headers and subjects, and bounces.
//
// IMAP shows no connecting IP, so SPF, and so a DMARC pass by SPF, cannot be checked here: only an aligned DKIM signature proves a From.
// A Microsoft 365 sender without DKIM for its own domain fails unless the installation's `trustedAuthservId` names the mailbox server,
// whose Authentication-Results then vouch by their `dmarc=pass`.
// shortcut: a password signs in to IMAP and SMTP; an Exchange Online mailbox, which takes only OAuth, cannot be the app's until one does.
import { Resolver } from "node:dns/promises";
import { setTimeout as sleep } from "node:timers/promises";
import EmailReplyParser from "email-reply-parser";
import { ImapFlow, type MailboxObject } from "imapflow";
import { authenticate, type DNSResolver } from "mailauth";
import { type ParsedMail, simpleParser } from "mailparser";
import { createTransport, type SendMailOptions } from "nodemailer";
import type { Credentials, SessionEvent, WorkSource } from "../ports.ts";

/** Sends one mail as the installation's account. */
export type Send = (
	credentials: Credentials,
	mail: SendMailOptions,
) => Promise<unknown>;

/** What a reply needs, as `sessionId` carries it: the sender's address, the thread's first Message-ID and its subject. */
type Thread = { to: string; root: string; subject: string };

/** The newest mail of the INBOX the connection has taken, by its UID in the INBOX's UIDVALIDITY. */
type Cursor = { uidValidity: string; lastUid: number };

/** The mail could not be checked for now (a DNS lookup failed): it is tried again before any mail after it. */
export class Unchecked extends Error {}

// RFC 9051 lets a server end an IDLE after 30 minutes, and NATs drop quiet connections sooner
const MAX_IDLE_MS = 4 * 60_000;
// IDLE tells of new mail, not that a mail held back can be tried again
const SWEEP_MS = 2 * 60_000;
const RECONNECT_MS = 1_000;
const MAX_RECONNECT_MS = 60_000;
// a DKIM key can be rotated out of DNS once its mail is delivered; OpenClaw's window
const FRESH_MS = 48 * 60 * 60_000;
// how often a mail whose DNS failed is tried before it is skipped, so it cannot hold up every mail after it
const MAX_ATTEMPTS = 3;

const dns = new Resolver({ timeout: 5_000, tries: 1 });
const lookup: DNSResolver = (domain, rrtype) =>
	rrtype === "TXT"
		? dns.resolveTxt(domain)
		: // DKIM and DMARC ask only for TXT; the type mailauth declares has no room for an MX record's object
			(dns.resolve(domain, rrtype) as Promise<string[]>);

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
		// a server tells of new mail only while the client idles, so idle soon after each sweep (ImapFlow waits 15 seconds)
		autoIdleDelay: 1000,
		verifyOnly,
	});

/** The subject without the reply and forward prefixes clients stack on it. */
export const baseSubject = (subject: string) =>
	subject.replace(/^(\s*(re|fwd?|回复|答复)\s*[:：])+\s*/i, "").trim();

const replies = new EmailReplyParser();
// what email-reply-parser does not know: Gmail's "于…写道：", 163's "在…写道:" with an ASCII colon, QQ's and Chinese Outlook's 原始邮件
// separator, and Chinese Outlook's 发件人 and 发送时间 header over the quoted mail
const CHINESE_QUOTE =
	/^(在|.*于).*写道\s*[:：]\s*$|^\s*-*\s*原始邮件\s*-*\s*$|^\s*发件人\s*[:：].*\n\s*(发送时间|时间|日期)\s*[:：]/m;

/** What the sender wrote this time: the text above the mail they quoted, without quoted lines or their signature. */
export function newPart(text: string): string {
	const cut = text.search(CHINESE_QUOTE);
	return replies.parseReply(cut < 0 ? text : text.slice(0, cut)).trim();
}

/** Why a machine sent the mail, which must never be answered (a loop); undefined for a person's. */
function machine(mail: ParsedMail, sender: string): string | undefined {
	const header = (key: string) =>
		mail.headerLines
			.find((h) => h.key === key)
			?.line.slice(key.length + 1)
			.trim()
			.toLowerCase();
	const autoSubmitted = header("auto-submitted")?.split(";")[0].trim();
	if (autoSubmitted && autoSubmitted !== "no")
		return `Auto-Submitted: ${autoSubmitted}`;
	// Outlook's and Exchange's autoresponders, and a mailing list's mail
	for (const key of ["x-autoreply", "x-auto-response-suppress", "list-id"])
		if (header(key) !== undefined) return `a ${key} header`;
	const precedence = header("precedence");
	if (precedence && ["bulk", "list", "junk", "auto_reply"].includes(precedence))
		return `Precedence: ${precedence}`;
	if (header("return-path") === "<>") return "a bounce";
	if (/^(mailer[-_]?daemon|post[-_]?master|no[-_]?reply)@/.test(sender))
		return `from ${sender}`;
	if (header("content-type")?.startsWith("multipart/report"))
		return "a delivery status notification";
	if (
		/^\s*(out of office|automatic reply|自动回复|自动答复)/i.test(
			mail.subject ?? "",
		)
	)
		return `an automatic reply's subject`;
}

/** The mail's topmost Authentication-Results, the receiving server's own (one below it the sender could have written), says DMARC passed. */
function asserted(mail: ParsedMail, authservId: string) {
	const line = mail.headerLines.find(
		(h) => h.key === "authentication-results",
	)?.line;
	if (!line) return false;
	const [id, ...methods] = line
		.slice(line.indexOf(":") + 1)
		.replace(/\r?\n[\t ]+/g, " ")
		.split(";");
	return (
		id
			.trim()
			.replace(/\s+\d+$/, "")
			.toLowerCase() === authservId.toLowerCase() &&
		methods.some((m) => /^\s*dmarc\s*=\s*pass\b/i.test(m))
	);
}

/**
 * Why the mail is not proven to be from its From: no DKIM signature of the From's domain covers all of it (OpenClaw's sender gate), nor
 * does a trusted server's DMARC pass vouch for it; undefined when it is proven. Throws `Unchecked` when DNS failed.
 */
async function unproven(
	raw: Buffer | string,
	mail: ParsedMail,
	trustedAuthservId: string | undefined,
	resolver: DNSResolver,
): Promise<string | undefined> {
	const result = await authenticate(raw, {
		resolver,
		disableArc: true,
		disableBimi: true,
	}).catch(() => undefined);
	const aligned = (result?.dkim.results ?? []).filter(
		(r) => r.status.result === "pass" && r.status.aligned,
	);
	if (aligned.some((r) => !r.status.underSized)) return;
	// with l= the signature leaves what follows its length unsigned, so anyone can append to it
	if (aligned.length) return "DKIM signs only part of the body";
	if (trustedAuthservId && asserted(mail, trustedAuthservId)) return;
	if (
		!result ||
		result.dkim.results.some((r) => r.status.result === "temperror")
	)
		throw new Unchecked("a DNS lookup failed");
	return "no DKIM signature of its domain";
}

/**
 * The mail the mailbox received at `received` as the event `id` it starts or prompts a session with; or why it is not acted on: it is
 * not from one person whose domain vouches for it, or a machine sent it, which must never be answered (a loop), or it is too old.
 */
export async function mailEvent(
	raw: Buffer | string,
	{ address, trustedAuthservId }: Credentials,
	{
		id,
		received,
		now = Date.now(),
		resolver = lookup,
	}: { id: string; received: Date; now?: number; resolver?: DNSResolver },
): Promise<SessionEvent | { skip: string }> {
	const mail = await simpleParser(raw, {
		skipImageLinks: true,
		skipTextLinks: true,
	});
	const senders = mail.from?.value ?? [];
	const sender = senders[0]?.address?.toLowerCase();
	if (
		mail.headerLines.filter((h) => h.key === "from").length !== 1 ||
		senders.length !== 1 ||
		!sender
	)
		return { skip: "not from one address" };
	if (sender === address.toLowerCase())
		return { skip: "sent by the mailbox itself" };
	const loop = machine(mail, sender);
	if (loop) return { skip: loop };
	if (now - received.getTime() > FRESH_MS)
		return { skip: "received over 48 hours ago" };
	const why = await unproven(raw, mail, trustedAuthservId, resolver);
	if (why) return { skip: `${why} for ${sender}` };
	const messageId = mail.messageId;
	if (!messageId) return { skip: "no Message-ID" };
	const references = [mail.references ?? []].flat();
	// shortcut: the root is the first of References, so a client that drops it starts another session; Zendesk and Intercom find the
	// session by any Message-ID in the chain, which needs a lookup kept with the sessions
	const root = references[0] ?? mail.inReplyTo ?? messageId;
	const thread: Thread = {
		to: sender,
		root,
		subject: baseSubject(mail.subject ?? ""),
	};
	return {
		id,
		sessionId: JSON.stringify(thread),
		action: root === messageId ? "created" : "prompted",
		from: { id: sender, name: senders[0].name || sender },
		issue: null,
		scope: null,
		shared: false,
		text: newPart(mail.text ?? "") || null,
		stop: false,
	};
}

type State = {
	load(): Promise<string | null>;
	save(value: string): Promise<void>;
};

/**
 * The saved cursor; or, when there is none or the INBOX's UIDs were renumbered (its UIDVALIDITY changed), one at its newest mail,
 * saved: mail that was there before is never answered.
 */
async function cursorOf(
	client: ImapFlow,
	box: MailboxObject,
	state: State,
): Promise<Cursor> {
	const uidValidity = String(box.uidValidity);
	const saved = await state.load();
	const cursor = saved ? (JSON.parse(saved) as Cursor) : undefined;
	if (cursor?.uidValidity === uidValidity) return cursor;
	const lastUid = box.uidNext
		? box.uidNext - 1
		: box.exists
			? ((await client.fetchOne("*", { uid: true })) || undefined)?.uid
			: 0;
	// a mail expunged as it was fetched: connecting again beats answering the whole INBOX
	if (lastUid === undefined) throw new Error("the INBOX's newest mail is gone");
	const baseline = { uidValidity, lastUid };
	await state.save(JSON.stringify(baseline));
	console.info(
		`Email: ${cursor ? "the INBOX was renumbered" : "first connection"}; taking mail after UID ${lastUid}`,
	);
	return baseline;
}

/**
 * Hands `onEvent` each mail past the cursor, oldest first, moving the cursor past it once `onEvent` has it or it is skipped for good.
 * Throws, leaving the cursor before the mail, when `onEvent` throws or the mail's DNS failed fewer than MAX_ATTEMPTS times.
 */
async function sweep(
	client: ImapFlow,
	cursor: Cursor,
	state: State,
	attempts: Map<string, number>,
	handle: (raw: Buffer, id: string, received: Date) => Promise<void>,
) {
	const uids: number[] = [];
	// `n:*` answers the INBOX's last mail even when its UID is below n
	for await (const m of client.fetch(
		`${cursor.lastUid + 1}:*`,
		{ uid: true },
		{ uid: true },
	))
		if (m.uid > cursor.lastUid) uids.push(m.uid);
	for (const uid of uids.sort((a, b) => a - b)) {
		const id = `${cursor.uidValidity}-${uid}`;
		const message =
			(await client.fetchOne(
				String(uid),
				{ source: true, internalDate: true },
				{ uid: true },
			)) || undefined;
		// a mail expunged since it was listed has nothing to take
		if (message?.source)
			try {
				await handle(
					message.source,
					id,
					new Date(message.internalDate ?? Date.now()),
				);
			} catch (error) {
				if (!(error instanceof Unchecked)) throw error;
				const tried = (attempts.get(id) ?? 0) + 1;
				attempts.set(id, tried);
				if (tried < MAX_ATTEMPTS) throw error;
				console.warn(
					`Email: skipping mail ${id}: ${error.message} ${tried} times`,
				);
			}
		attempts.delete(id);
		cursor.lastUid = uid;
		await state.save(JSON.stringify(cursor));
	}
}

/** The email WorkSource, sending by `send`, checking DKIM by `resolver` (DNS by default). */
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
		// nodemailer gives it a unique Message-ID on the From's domain
		from: address,
		to,
		subject,
		text,
		inReplyTo: root,
		references: root,
		// RFC 3834, and Exchange's own: so the sender's autoresponder does not answer it
		headers: {
			"Auto-Submitted": "auto-replied",
			"X-Auto-Response-Suppress": "All",
		},
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
				// optional: the mailbox server's authserv-id, whose Authentication-Results' dmarc=pass also proves a From
				{ name: "trustedAuthservId", secret: false },
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
			// a mailbox takes a handful of connections per account
			exclusive: true,
			async connect(auth, onEvent, signal, state) {
				// shortcut: the counts are this process's, so a worker restarting gives such a mail MAX_ATTEMPTS more tries
				const attempts = new Map<string, number>();
				let failures = 0;
				while (!signal.aborted) {
					const { credentials } = await auth();
					const handle = async (raw: Buffer, id: string, received: Date) => {
						const event = await mailEvent(raw, credentials, {
							id,
							received,
							resolver,
						}).catch((error) => {
							if (error instanceof Unchecked) throw error;
							// a mail that cannot be read fails the same on every try, so it is skipped, not retried
							return { skip: `unreadable: ${error}` };
						});
						if ("skip" in event)
							console.info(`Email: not acting on mail ${id}: ${event.skip}`);
						else await onEvent(event);
					};
					const client = imap(credentials);
					// new mail, the connection closing, or the next sweep's time ends the wait between sweeps
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
						const box = await client.mailboxOpen("INBOX", { readOnly: true });
						const cursor = await cursorOf(client, box, state);
						failures = 0;
						while (!signal.aborted && client.usable) {
							if (!dirty)
								await new Promise<void>((resolve) => {
									const timer = setTimeout(resolve, SWEEP_MS);
									wake = () => {
										clearTimeout(timer);
										resolve();
									};
								});
							dirty = false;
							if (client.usable)
								// a mail held back is tried again at the next sweep, on the same connection
								await sweep(client, cursor, state, attempts, handle).catch(
									(error) => {
										if (!signal.aborted)
											console.warn("Email: a mail is held back", error);
									},
								);
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
					// ImapFlow does not reconnect by itself
					const delay = Math.min(
						RECONNECT_MS * 2 ** failures++,
						MAX_RECONNECT_MS,
					);
					await sleep(delay + Math.random() * (delay / 4), undefined, {
						signal,
					}).catch(() => {});
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
