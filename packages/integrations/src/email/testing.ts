// A scripted mailbox for testing the email source without one: an IMAP server on localhost, nodemailer's stream transport in place
// of SMTP, and DNS answered from a table.
import { generateKeyPairSync } from "node:crypto";
import { createServer, type Socket } from "node:net";
import { type DNSResolver, dkimSign } from "mailauth";
import { type ParsedMail, simpleParser } from "mailparser";
import { createTransport } from "nodemailer";
import type { Credentials } from "../ports.ts";
import type { Send } from "./index.ts";

/** `send` builds each mail as SMTP would send it; `sent` holds who it was sent as, its envelope and the mail parsed back. */
export function fakeSmtp() {
	const transport = createTransport({ streamTransport: true, buffer: true });
	const sent: {
		credentials: Credentials;
		envelope: { from: string | false; to: string[] };
		mail: ParsedMail;
	}[] = [];
	const send: Send = async (credentials, mail) => {
		const info = await transport.sendMail(mail);
		sent.push({
			credentials,
			envelope: info.envelope,
			mail: await simpleParser(info.message as Buffer),
		});
	};
	return { send, sent };
}

/** A DNS that answers `records` ("TXT name" → its TXT strings) and nothing else. */
export function fakeDns(records: Record<string, string[]>): DNSResolver {
	return async (domain, rrtype) => {
		const found = records[`${rrtype} ${domain}`];
		if (found) return found.map((txt) => [txt]);
		throw Object.assign(new Error(`queryTxt ENOTFOUND ${domain}`), {
			code: "ENOTFOUND",
		});
	};
}

/**
 * A domain that DKIM-signs its mail: `records` are its DNS, its key and a DMARC policy of reject. A mail one domain signs whose From
 * is another's plays a forger signing as themselves.
 */
export function dkim(domain: string) {
	const { privateKey, publicKey } = generateKeyPairSync("rsa", {
		modulusLength: 2048,
	});
	const p = publicKey
		.export({ type: "spki", format: "der" })
		.toString("base64");
	return {
		records: {
			[`TXT s1._domainkey.${domain}`]: [`v=DKIM1; k=rsa; p=${p}`],
			[`TXT _dmarc.${domain}`]: ["v=DMARC1; p=reject"],
		},
		async sign(raw: string) {
			const { signatures } = await dkimSign(raw, {
				signatureData: [
					{
						signingDomain: domain,
						selector: "s1",
						privateKey: privateKey.export({ type: "pkcs1", format: "pem" }),
					},
				],
			});
			return signatures + raw;
		},
	};
}

/**
 * An IMAP server on localhost holding one INBOX, speaking as much IMAP4rev1 and IDLE as ImapFlow uses. `deliver` adds a mail (told to
 * an idling client at once, or once it idles, as a real server does); `messages` are the mail with their `seen` flag; and `logins` counts the sign-ins.
 */
export async function fakeImap({
	username = "agent@orqestra.test",
	password = "imap-s3cret",
} = {}) {
	const messages: { uid: number; raw: string; seen: boolean }[] = [];
	const sockets = new Set<Socket>();
	// each idling client's way to tell it of mail it has not heard of
	const idling = new Map<Socket, () => void>();
	let logins = 0;
	const unquote = (s = "") => s.replace(/^"(.*)"$/, "$1");
	const uids = (set: string) =>
		set.split(",").flatMap((part) => {
			const [a, b = a] = part.split(":");
			const top = messages.at(-1)?.uid ?? 0;
			const lo = a === "*" ? top : Number(a);
			const hi = b === "*" ? top : Number(b);
			return messages
				.filter((m) => m.uid >= Math.min(lo, hi) && m.uid <= Math.max(lo, hi))
				.map((m) => m.uid);
		});

	const server = createServer((socket) => {
		sockets.add(socket);
		socket.on("close", () => {
			sockets.delete(socket);
			idling.delete(socket);
		});
		socket.on("error", () => {});
		const write = (line: string) => socket.write(`${line}\r\n`);
		let buffer = "";
		let idleTag = "";
		let known = 0;
		const tell = () => {
			if (messages.length === known) return;
			known = messages.length;
			write(`* ${known} EXISTS`);
		};
		write("* OK [CAPABILITY IMAP4rev1 IDLE] fake IMAP ready");
		socket.on("data", (chunk) => {
			buffer += chunk.toString("utf8");
			for (
				let at = buffer.indexOf("\r\n");
				at >= 0;
				at = buffer.indexOf("\r\n")
			) {
				const line = buffer.slice(0, at);
				buffer = buffer.slice(at + 2);
				if (idleTag) {
					if (line.toUpperCase() === "DONE") {
						idling.delete(socket);
						write(`${idleTag} OK IDLE terminated`);
						idleTag = "";
					}
					continue;
				}
				const [tag, command = "", ...args] = line.split(" ");
				const ok = (text = "done") => write(`${tag} OK ${text}`);
				const uid = command.toUpperCase() === "UID";
				const verb = (uid ? args.shift() : command)?.toUpperCase();
				switch (verb) {
					case "CAPABILITY":
						write("* CAPABILITY IMAP4rev1 IDLE");
						ok();
						break;
					case "LOGIN":
						if (
							unquote(args[0]) === username &&
							unquote(args[1]) === password
						) {
							logins++;
							ok("[CAPABILITY IMAP4rev1 IDLE] signed in");
						} else
							write(`${tag} NO [AUTHENTICATIONFAILED] Invalid credentials`);
						break;
					case "LIST":
					case "LSUB":
						write(
							/INBOX/i.test(args[1])
								? `* ${verb} () "/" INBOX`
								: `* ${verb} (\\Noselect) "/" ""`,
						);
						ok();
						break;
					case "SELECT":
					case "EXAMINE":
						write("* FLAGS (\\Seen)");
						known = messages.length;
						write(`* ${known} EXISTS`);
						write("* OK [UIDVALIDITY 1] UIDs valid");
						write(`* OK [UIDNEXT ${(messages.at(-1)?.uid ?? 0) + 1}] next`);
						ok("[READ-WRITE] selected");
						break;
					case "SEARCH": {
						const unseen = /UNSEEN|NOT SEEN/i.test(args.join(" "));
						const found = messages.filter((m) => !unseen || !m.seen);
						write(
							`* SEARCH${found.map((m) => ` ${uid ? m.uid : messages.indexOf(m) + 1}`).join("")}`,
						);
						ok();
						break;
					}
					case "FETCH":
						for (const n of uids(args[0])) {
							const m = messages.find((x) => x.uid === n);
							if (!m) continue;
							const bytes = Buffer.byteLength(m.raw);
							socket.write(
								`* ${messages.indexOf(m) + 1} FETCH (UID ${m.uid} BODY[] {${bytes}}\r\n${m.raw})\r\n`,
							);
						}
						ok();
						break;
					case "STORE":
						if (
							/\+FLAGS/i.test(args[1]) &&
							/\\Seen/i.test(args.slice(2).join(" "))
						)
							for (const n of uids(args[0])) {
								const m = messages.find((x) => x.uid === n);
								if (m) m.seen = true;
							}
						ok();
						break;
					case "IDLE":
						idleTag = tag;
						idling.set(socket, tell);
						write("+ idling");
						tell();
						break;
					case "NOOP":
						ok();
						break;
					case "LOGOUT":
						write("* BYE logging out");
						ok();
						socket.end();
						break;
					default:
						write(`${tag} BAD unknown command ${verb}`);
				}
			}
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	const port = typeof address === "object" && address ? address.port : 0;

	return {
		messages,
		get logins() {
			return logins;
		},
		credentials: {
			address: username,
			imapHost: "127.0.0.1",
			imapPort: String(port),
			smtpHost: "127.0.0.1",
			smtpPort: "2525",
			username,
			password,
		} satisfies Credentials,
		deliver(raw: string) {
			messages.push({ uid: (messages.at(-1)?.uid ?? 0) + 1, raw, seen: false });
			for (const tell of idling.values()) tell();
		},
		async close() {
			for (const socket of sockets) socket.destroy();
			await new Promise((resolve) => server.close(resolve));
		},
	};
}
