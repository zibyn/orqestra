import type {
	Api,
	AssistantMessage,
	Message,
	Model,
} from "@earendil-works/pi-ai";
import type { RunHandle } from "@orqestra/conversations";
import { messageText } from "@orqestra/conversations/shared";

/** Milliseconds a title may take before it is given up, for the next Turn to try again. */
const TITLE_TIMEOUT = 30_000;

/** A title for a Conversation from its first question and answer; none unless the model finished it within TITLE_TIMEOUT. */
export async function generateTitle(
	question: Message,
	answer: AssistantMessage,
	model: Model<Api>,
	/** The Run's, metered: `run.streamSimple("title")`. */
	streamSimple: ReturnType<RunHandle["streamSimple"]>,
) {
	// no reasoning option: thinking stays off
	const stream = await streamSimple(
		model,
		{
			systemPrompt:
				"Write a title of at most 20 characters for this conversation, in the language the user writes in. Reply with the title only, without quotes or punctuation at the end.",
			messages: [
				{
					role: "user",
					content: `User: ${messageText(question)}\n\nAssistant: ${messageText(answer)}`,
					timestamp: Date.now(),
				},
			],
		},
		// nothing else bounds it, a Provider's SDK timeout ending once its headers arrive: a hung one gives the title up
		{ signal: AbortSignal.timeout(TITLE_TIMEOUT) },
	);
	const result = await stream.result();
	const title = [
		...messageText(result)
			.trim()
			.replace(/^["'“「]|["'”」]$/g, ""),
	]
		.slice(0, 20)
		.join("");
	if (result.stopReason !== "stop" || !title) return undefined;
	return title;
}
