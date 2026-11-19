// Integration Accounts (ADR 0019): which Orqestra User each person of an Integration's workspace is, learned by their authorizing as
// themselves through the app's OAuth client, never by matching emails. Orqestra keeps none of their tokens.
import { db } from "@orqestra/db";
import {
	integrationAccount as account,
	integrationInstallation as installation,
} from "@orqestra/db/schema";
import { decryptSecret, encryptSecret } from "@orqestra/db/secret";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { callbackUrl, GrantRefused, tokenGrant } from "./installation.ts";
import type { Fetch, WorkSource } from "./ports.ts";

/** How long the User has at the authorization page. */
const PENDING_TTL_MS = 10 * 60_000;

const pending = z.object({
	account: z.string(),
	userId: z.string(),
	expiresAt: z.number(),
});

/**
 * The User a callback's `state` was started for, when it is an account authorization of `source` started within PENDING_TTL_MS:
 * undefined for any other state, such as an installation's. Sealed with ORQESTRA_ENCRYPTION_KEY, so nobody can make one for another User.
 */
export function accountState(source: WorkSource, state: string | null) {
	const plain = state ? decryptSecret(state) : undefined;
	const parsed = plain ? pending.safeParse(JSON.parse(plain)) : undefined;
	return parsed?.success &&
		parsed.data.account === source.kind &&
		parsed.data.expiresAt > Date.now()
		? parsed.data.userId
		: undefined;
}

/** The URL to send the User to so they authorize as themselves; undefined until the app's credentials are saved. */
export async function startAccount(
	source: WorkSource,
	userId: string,
	orqestraUrl: string,
) {
	const row = await db.query.integrationInstallation.findFirst({
		where: eq(installation.kind, source.kind),
		columns: { clientId: true },
	});
	if (!row) return undefined;
	const url = new URL(source.authorize.url);
	url.search = new URLSearchParams({
		client_id: row.clientId,
		redirect_uri: callbackUrl(source, orqestraUrl),
		response_type: "code",
		scope: source.accountScope,
		state: encryptSecret(
			JSON.stringify({
				account: source.kind,
				userId,
				expiresAt: Date.now() + PENDING_TTL_MS,
			}),
		),
	}).toString();
	return url.href;
}

export type FinishAccountError = "state_invalid" | "denied" | "failed";

/**
 * The redirect back to the User `userId` signed in: links them to the person who authorized, replacing the account they had linked,
 * and taking that person from any other User, since authorizing as them is the proof. Revokes the token it was given.
 */
export async function finishAccount(
	source: WorkSource,
	userId: string,
	query: URLSearchParams,
	{
		orqestraUrl,
		fetch = globalThis.fetch,
	}: { orqestraUrl: string; fetch?: Fetch },
): Promise<FinishAccountError | undefined> {
	if (accountState(source, query.get("state")) !== userId)
		return "state_invalid";
	const code = query.get("code");
	if (!code) return "denied";
	try {
		const row = await db.query.integrationInstallation.findFirst({
			where: eq(installation.kind, source.kind),
			columns: { clientId: true, clientSecret: true },
		});
		if (!row) return "failed";
		const { access_token: token } = z
			.object({ access_token: z.string() })
			.parse(
				await tokenGrant(source, fetch, {
					grant_type: "authorization_code",
					code,
					redirect_uri: callbackUrl(source, orqestraUrl),
					client_id: row.clientId,
					client_secret: decryptSecret(row.clientSecret) ?? "",
				}),
			);
		const person = await source.account(token, fetch);
		await source
			.revoke(token, fetch)
			.catch((error) =>
				console.error(
					`Revoking a ${source.name} account's token failed`,
					error,
				),
			);
		await db.transaction(async (tx) => {
			await tx
				.delete(account)
				.where(and(eq(account.kind, source.kind), eq(account.userId, userId)));
			await tx
				.insert(account)
				.values({
					kind: source.kind,
					externalId: person.id,
					userId,
					name: person.name,
				})
				.onConflictDoUpdate({
					target: [account.kind, account.externalId],
					set: { userId, name: person.name, createdAt: new Date() },
				});
		});
		return undefined;
	} catch (error) {
		if (!(error instanceof GrantRefused))
			console.error(`Linking a ${source.name} account failed`, error);
		return "failed";
	}
}

/** The account the User linked, as the Connections page shows it; null when none. */
export async function accountOf(source: WorkSource, userId: string) {
	const [row] = await db
		.select({ name: account.name, createdAt: account.createdAt })
		.from(account)
		.where(and(eq(account.kind, source.kind), eq(account.userId, userId)));
	return row ?? null;
}

/** Forgets the account the User linked. */
export async function unlinkAccount(source: WorkSource, userId: string) {
	await db
		.delete(account)
		.where(and(eq(account.kind, source.kind), eq(account.userId, userId)));
}

/** The Orqestra User a person of the workspace linked to, by the id the Integration's events name them with. */
export async function accountUser(source: WorkSource, externalId: string) {
	const [row] = await db
		.select({ userId: account.userId })
		.from(account)
		.where(
			and(eq(account.kind, source.kind), eq(account.externalId, externalId)),
		);
	return row?.userId;
}
