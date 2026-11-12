/** A request the User may not make as it stands; `field` and `code` say why, for the api's error body. */
export class ConversationError extends Error {
	override name = "ConversationError";
	constructor(
		message: string,
		readonly field: string,
		readonly code: string,
	) {
		super(message);
	}
}
