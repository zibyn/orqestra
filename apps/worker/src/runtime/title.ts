import type {
	Api,
	AssistantMessage,
	Message,
	Model,
} from "@earendil-works/pi-ai";
import { messageText, type OrqestraConfig } from "@orqestra/config";

/** A title for a Conversation from its first question and answer; none unless the model finished it. */
export async function generateTitle(
	question: Message,
	answer: AssistantMessage,
	model: Model<Api>,
	streamSimple: OrqestraConfig["streamSimple"],
) {
	// no reasoning option: thinking stays off
	const stream = await streamSimple(model, {
		systemPrompt:
			"Write a title of at most 20 characters for this conversation, in the language the user writes in. Reply with the title only, without quotes or punctuation at the end.",
		messages: [
			{
				role: "user",
				content: `User: ${messageText(question)}\n\nAssistant: ${messageText(answer)}`,
				timestamp: Date.now(),
			},
		],
	});
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
