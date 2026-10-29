import type { SaveError, SaveErrors } from "@orqestra/config/shared";
import { m } from "#/paraglide/messages";

/** A field error of a /console save, in the User's language. */
export function saveErrorText(error: SaveError): string {
	switch (error.code) {
		case "invalid":
			return m.save_invalid({ detail: error.detail });
		case "header_invalid":
			return m.mcp_header_invalid({ header: error.header });
		case "header_twice":
			return m.mcp_header_twice({ header: error.header });
		case "header_value_missing":
			return m.mcp_header_value_missing({ header: error.header });
		case "default_model_not_allowed":
			return m.save_default_model_not_allowed({ model: error.model });
		case "thinking_default_not_allowed":
			return m.save_thinking_default_not_allowed({ level: error.level });
		default:
			return {
				api_key_required: m.api_key_required,
				not_in_catalog: m.save_not_in_catalog,
				not_found: m.save_not_found,
				id_invalid: m.save_id_invalid,
				id_taken: m.save_id_taken,
				default_required: m.save_default_required,
				default_not_pickable: m.save_default_not_pickable,
			}[error.code]();
	}
}

/** Every field error of a save, translated, by field. */
export const saveErrorTexts = (errors: SaveErrors) =>
	Object.fromEntries(
		Object.entries(errors).map(([field, e]) => [field, saveErrorText(e)]),
	);
