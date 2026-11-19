// Integration Accounts (ADR 0019, 0020): which Orqestra User each person of an Integration's workspace is, learned by their authorizing
// as themselves through the app's OAuth client, or by their opening, signed in to Orqestra, a link the app sent them where only they
// read it; never by matching emails. Orqestra keeps none of their tokens.
import { db } from "@orqestra/db";
import {
	integrationAccount as account,
	type IntegrationKind,
	integrationInstallation as installation,
} from "@orqestra/db/schema";
import { decryptSecret, encryptSecret } from "@orqestra/db/secret";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { callbackUrl, GrantRefused, tokenGrant } from "./installation.ts";
import type { Credentials, Fetch, OAuthClient, WorkSource } from "./ports.ts";

/** How long the User has at the authorization page, and to open a private link. */
const PENDING_TTL_MS = 10 * 60_000;

const pending = z.object({
	account: z.string(),
	userId: z.string(),
	expiresAt: z.number(),
});

const sentLink = z.object({
	account: z.string(),
	externalId: z.string(),
	name: z.string(),
	expiresAt: z.number(),
});

/** What a value sealed with ORQESTRA_ENCRYPTION_KEY holds, when it is `schema`'s and has not expired. */
function unsealed<T extends { expiresAt: number }>(
	schema: z.ZodType<T>,
	value: string | null,
) {
	const plain = value ? decryptSecret(value) : undefined;
	const parsed = plain ? schema.safeParse(JSON.parse(plain)) : undefined;
	return parsed?.success && parsed.data.expiresAt > Date.now()
		? parsed.data
		: undefined;
}

/**
 * The User a callback's `state` was started for, when it is an account authorization of `source` started within PENDING_TTL_MS:
 * undefined for any other state, such as an installation's. Sealed with ORQESTRA_ENCRYPTION_KEY, so nobody can make one for another User.
 */
export function accountState(source: WorkSource, state: string | null) {
	const sealed = unsealed(pending, state);
	return sealed?.account === source.kind ? sealed.userId : undefined;
}

/** The OAuth client people authorize as themselves through: the installation's own, or its credentials' `clientId` and `clientSecret`. */
async function oauthClient(
	source: WorkSource,
): Promise<OAuthClient | undefined> {
	const row = await db.query.integrationInstallation.findFirst({
		where: eq(installation.kind, source.kind),
		columns: { clientId: true, clientSecret: true, credentials: true },
	});
	if (row?.clientId)
		return {
			id: row.clientId,
			secret: (row.clientSecret && decryptSecret(row.clientSecret)) ?? "",
		};
	const plain = row?.credentials ? decryptSecret(row.credentials) : undefined;
	const credentials: Credentials = plain ? JSON.parse(plain) : {};
	return credentials.clientId
		? { id: credentials.clientId, secret: credentials.clientSecret ?? "" }
		: undefined;
}

/** The URL to send the User to so they authorize as themselves; undefined until the app's OAuth client is saved, or for a source whose people prove themselves another way. */
export async function startAccount(
	source: WorkSource,
	userId: string,
	orqestraUrl: string,
) {
	const { proof } = source;
	if (proof.mode !== "oauth") return undefined;
	const client = await oauthClient(source);
	if (!client) return undefined;
	const url = new URL(proof.authorizeUrl);
	url.search = new URLSearchParams({
		client_id: client.id,
		redirect_uri: callbackUrl(source, orqestraUrl),
		response_type: "code",
		scope: proof.scope,
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

/** Links the User to the person, replacing the account they had linked, and taking that person from any other User, since the proof is theirs. */
async function linkAccount(
	kind: IntegrationKind,
	userId: string,
	person: { id: string; name: string },
) {
	await db.transaction(async (tx) => {
		await tx
			.delete(account)
			.where(and(eq(account.kind, kind), eq(account.userId, userId)));
		await tx
			.insert(account)
			.values({ kind, externalId: person.id, userId, name: person.name })
			.onConflictDoUpdate({
				target: [account.kind, account.externalId],
				set: { userId, name: person.name, createdAt: new Date() },
			});
	});
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
	const { proof } = source;
	if (
		proof.mode !== "oauth" ||
		accountState(source, query.get("state")) !== userId
	)
		return "state_invalid";
	const code = query.get("code");
	if (!code) return "denied";
	try {
		const client = await oauthClient(source);
		if (!client) return "failed";
		const { access_token: token } = z
			.object({ access_token: z.string() })
			.parse(
				await tokenGrant(source, proof.tokenUrl, fetch, {
					grant_type: "authorization_code",
					code,
					redirect_uri: callbackUrl(source, orqestraUrl),
					client_id: client.id,
					client_secret: client.secret,
				}),
			);
		const person = await proof.account(token, fetch);
		await proof
			.revoke(token, client, fetch)
			.catch((error) =>
				console.error(
					`Revoking a ${source.name} account's token failed`,
					error,
				),
			);
		await linkAccount(source.kind, userId, person);
		return undefined;
	} catch (error) {
		if (!(error instanceof GrantRefused))
			console.error(`Linking a ${source.name} account failed`, error);
		return "failed";
	}
}

/**
 * The link that proves whoever opens it, signed in to Orqestra within PENDING_TTL_MS, to be `person`: for the app to send where only
 * they read it. On Orqestra's Connections page, under `orqestraUrl` when given.
 */
export function privateLink(
	source: WorkSource,
	person: { id: string; name: string },
	orqestraUrl?: string,
) {
	const page = `/connections?${new URLSearchParams({
		link: encryptSecret(
			JSON.stringify({
				account: source.kind,
				externalId: person.id,
				name: person.name,
				expiresAt: Date.now() + PENDING_TTL_MS,
			}),
		),
	})}`;
	return orqestraUrl ? new URL(page, orqestraUrl).href : page;
}

/**
 * Links the User `userId` signed in to the person a private link was sent to, as finishAccount does: the kind it linked, or undefined
 * when it is no link Orqestra sealed in the last PENDING_TTL_MS.
 */
export async function finishLink(userId: string, link: string) {
	const sent = unsealed(sentLink, link);
	if (!sent) return undefined;
	// sealed with Orqestra's key, so a kind privateLink was given
	const kind = sent.account as IntegrationKind;
	await linkAccount(kind, userId, { id: sent.externalId, name: sent.name });
	return kind;
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
