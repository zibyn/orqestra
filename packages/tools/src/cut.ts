// shortcut: a hard cut keeps one page or MCP Tool result from flooding the context; summarize instead if results get cut too often
const MAX_RESULT_CHARS = 50_000;

/** A Tool's text result, cut when it is too long. */
export const cut = (text: string) =>
	text.length > MAX_RESULT_CHARS
		? `${text.slice(0, MAX_RESULT_CHARS)}\n\n[The result was cut off here.]`
		: text;
