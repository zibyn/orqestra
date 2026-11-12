// No Node imports: browser code can use this module (as @orqestra/conversations/shared)
import type { Message } from "@earendil-works/pi-ai";
import { z } from "zod";

/** A Spending Limit: none, or so many dollars a calendar month; $0 lets nothing be spent. */
export const spendingLimit = z.discriminatedUnion("mode", [
	z.object({ mode: z.literal("unlimited") }),
	z.object({ mode: z.literal("limited"), usd: z.number().nonnegative() }),
]);
export type SpendingLimit = z.infer<typeof spendingLimit>;

/** A User's own Spending Limit, or `default`: the Limits' default for everyone. */
export const userSpendingLimit = z.discriminatedUnion("mode", [
	z.object({ mode: z.literal("default") }),
	...spendingLimit.options,
]);
export type UserSpendingLimit = z.infer<typeof userSpendingLimit>;

/** An IANA time zone name this runtime knows. */
export const timeZone = z.string().refine((zone) => {
	try {
		new Intl.DateTimeFormat("en", { timeZone: zone });
		return true;
	} catch {
		return false;
	}
}, "not a time zone");

/** The largest attachment a User can upload into a Sandbox. */
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

/** A message's text, without thinking or tool calls. */
export const messageText = (message: Message) =>
	typeof message.content === "string"
		? message.content
		: message.content.map((c) => (c.type === "text" ? c.text : "")).join("");
