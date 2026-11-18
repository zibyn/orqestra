// Orqestra's Linear app: installing it into a Linear workspace as itself (OAuth with actor=app), its tokens, and GraphQL as the app.
// Linear's access tokens last 24 hours; each refresh rotates the refresh token, which lapses 30 days after it was issued.
import { randomBytes } from "node:crypto";
import { db } from "@orqestra/db";
import { linearInstallation } from "@orqestra/db/schema";
import {
	decryptSecret,
	encryptSecret,
	secretReadable,
} from "@orqestra/db/secret";
import { and, eq, gt } from "drizzle-orm";
import { z } from "zod";

export type Fetch = (
	input: string | URL,
	init?: RequestInit,
) => Promise<Response>;

/** What Orqestra asks of the workspace: to read and write, and to be assigned issues and mentioned as an agent. */
const LINEAR_SCOPES = "read,write,app:assignable,app:mentionable";

/** How long the Admin has at Linear's authorization page. */
const PENDING_TTL_MS = 10 * 60_000;

/** An access token is refreshed once it expires within this. */
const REFRESH_MARGIN_MS = 60_000;

export const linearInstallationInput = z.object({
	clientId: z.string().trim().min(1),
	// blank keeps the stored one
	clientSecret: z.string().trim().optional(),
	webhookSecret: z.string().trim().optional(),
});

/** Where Linear sends the Admin back to, the OAuth app's callback URL. */
export const linearCallbackUrl = (orqestraUrl: string) =>
	new URL("/api/linear/callback", orqestraUrl).href;

type LinearTokens = {
	accessToken: string;
	refreshToken: string;
	/** Ms since the epoch. */
	expiresAt: number;
};

const sealed = (tokens: LinearTokens) => encryptSecret(JSON.stringify(tokens));
const opened = (stored: string): LinearTokens | undefined => {
	const plain = decryptSecret(stored);
	return plain === undefined ? undefined : JSON.parse(plain);
};

/** The installation as the console shows it, or null; secrets and tokens only go in. `workspace` is null until it is installed. */
export async function linearInstallationStatus() {
	const row = await db.query.linearInstallation.findFirst();
	return row
		? {
				clientId: row.clientId,
				clientSecretReadable: secretReadable(row.clientSecret),
				webhookSecretReadable: secretReadable(row.webhookSecret),
				// tokens that no longer decrypt need installing again
				workspace:
					row.tokens && secretReadable(row.tokens) ? row.workspace : null,
			}
		: null;
}

/**
 * Saves the app's credentials and starts installing it: the Linear URL to send the Admin to, valid for PENDING_TTL_MS and voiding
 * any earlier one. Another client_id forgets the installation of the app it replaces.
 */
export async function startInstallation(
	input: z.infer<typeof linearInstallationInput>,
	orqestraUrl: string,
): Promise<{
	errors: Partial<
		Record<"clientSecret" | "webhookSecret", { code: "secret_required" }>
	>;
	url?: string;
}> {
	const stored = await db.query.linearInstallation.findFirst();
	const keep = (secret: string | undefined) =>
		secret && secretReadable(secret) ? secret : undefined;
	const clientSecret = input.clientSecret
		? encryptSecret(input.clientSecret)
		: keep(stored?.clientSecret);
	const webhookSecret = input.webhookSecret
		? encryptSecret(input.webhookSecret)
		: keep(stored?.webhookSecret);
	if (!clientSecret || !webhookSecret)
		return {
			errors: {
				...(!clientSecret && { clientSecret: { code: "secret_required" } }),
				...(!webhookSecret && { webhookSecret: { code: "secret_required" } }),
			},
		};
	const state = randomBytes(32).toString("base64url");
	const values = {
		clientId: input.clientId,
		clientSecret,
		webhookSecret,
		pendingState: state,
		pendingAt: new Date(),
		...(stored?.clientId !== input.clientId && {
			tokens: null,
			workspace: null,
		}),
	};
	await db
		.insert(linearInstallation)
		.values(values)
		.onConflictDoUpdate({ target: linearInstallation.id, set: values });
	const url = new URL("https://linear.app/oauth/authorize");
	url.search = new URLSearchParams({
		client_id: input.clientId,
		redirect_uri: linearCallbackUrl(orqestraUrl),
		response_type: "code",
		scope: LINEAR_SCOPES,
		state,
		actor: "app",
	}).toString();
	return { errors: {}, url: url.href };
}

export type FinishInstallationError = "state_invalid" | "denied" | "failed";

/**
 * Linear's redirect back (`code` and `state`, or `error`): installs the app when it answers the authorization last started, within
 * PENDING_TTL_MS and once, storing its tokens and the workspace's name.
 */
export async function finishInstallation(
	query: URLSearchParams,
	{
		orqestraUrl,
		fetch = globalThis.fetch,
	}: { orqestraUrl: string; fetch?: Fetch },
): Promise<FinishInstallationError | undefined> {
	const state = query.get("state");
	if (!state) return "state_invalid";
	// taken in the statement that reads it, so two callbacks with one state install once
	const [taken] = await db
		.update(linearInstallation)
		.set({ pendingState: null, pendingAt: null })
		.where(
			and(
				eq(linearInstallation.pendingState, state),
				gt(linearInstallation.pendingAt, new Date(Date.now() - PENDING_TTL_MS)),
			),
		)
		.returning();
	if (!taken) return "state_invalid";
	const code = query.get("code");
	if (!code) return "denied";
	try {
		const tokens = await tokenRequest(fetch, {
			grant_type: "authorization_code",
			code,
			redirect_uri: linearCallbackUrl(orqestraUrl),
			client_id: taken.clientId,
			client_secret: decryptSecret(taken.clientSecret) ?? "",
		});
		const { organization } = z
			.object({ organization: z.object({ name: z.string() }) })
			.parse(
				await linearGraphql(
					tokens.accessToken,
					"{ organization { name } }",
					fetch,
				),
			);
		await db
			.update(linearInstallation)
			.set({ tokens: sealed(tokens), workspace: organization.name })
			// not over the app of an installation started since
			.where(eq(linearInstallation.clientId, taken.clientId));
		return undefined;
	} catch (error) {
		console.error("Installing the Linear app failed", error);
		return "failed";
	}
}

/**
 * The app's access token, refreshed first when it is about to expire; undefined when the app is not installed or its tokens no longer
 * decrypt. Throws when Linear refuses the refresh. Holds the installation's row lock, so processes refresh one at a time.
 */
export const linearAccessToken = ({
	fetch = globalThis.fetch,
}: {
	fetch?: Fetch;
} = {}) =>
	db.transaction(async (tx) => {
		const [row] = await tx.select().from(linearInstallation).for("update");
		const tokens = row?.tokens ? opened(row.tokens) : undefined;
		if (!row || !tokens) return undefined;
		if (tokens.expiresAt - REFRESH_MARGIN_MS > Date.now())
			return tokens.accessToken;
		const refreshed = await tokenRequest(fetch, {
			grant_type: "refresh_token",
			refresh_token: tokens.refreshToken,
			client_id: row.clientId,
			client_secret: decryptSecret(row.clientSecret) ?? "",
		});
		await tx.update(linearInstallation).set({ tokens: sealed(refreshed) });
		return refreshed.accessToken;
	});

const tokenResponse = z.object({
	access_token: z.string(),
	refresh_token: z.string(),
	expires_in: z.number(),
});

/** A grant at Linear's token endpoint, which takes only a form. */
async function tokenRequest(
	fetch: Fetch,
	params: Record<string, string>,
): Promise<LinearTokens> {
	const response = await fetch("https://api.linear.app/oauth/token", {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams(params),
		signal: AbortSignal.timeout(30_000),
	});
	if (!response.ok)
		throw new Error(
			`Linear's token endpoint answered ${response.status}: ${await response.text()}`,
		);
	const body = tokenResponse.parse(await response.json());
	return {
		accessToken: body.access_token,
		refreshToken: body.refresh_token,
		expiresAt: Date.now() + body.expires_in * 1000,
	};
}

/** One GraphQL request to Linear with an access token: its `data`; throws on an HTTP or GraphQL error. */
export async function linearGraphql(
	accessToken: string,
	query: string,
	fetch: Fetch = globalThis.fetch,
): Promise<unknown> {
	const response = await fetch("https://api.linear.app/graphql", {
		method: "POST",
		headers: {
			authorization: `Bearer ${accessToken}`,
			"content-type": "application/json",
		},
		body: JSON.stringify({ query }),
		signal: AbortSignal.timeout(30_000),
	});
	const body = (await response.json().catch(() => ({}))) as {
		data?: unknown;
		errors?: { message: string }[];
	};
	if (!response.ok || body.errors?.length || body.data == null)
		throw new Error(
			`Linear's GraphQL API answered ${response.status}: ${body.errors?.map((e) => e.message).join("; ") ?? ""}`,
		);
	return body.data;
}
