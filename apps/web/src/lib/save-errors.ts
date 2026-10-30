import type { SaveError, SaveErrors } from "@orqestra/config/shared";
import { m } from "#/paraglide/messages";

type Code = SaveError["code"];
const texts: {
	[C in Code]: (error: SaveError & { code: C }) => string;
} = {
	api_key_required: () => m.api_key_required(),
	not_in_catalog: () => m.save_not_in_catalog(),
	not_found: () => m.save_not_found(),
	id_invalid: () => m.save_id_invalid(),
	id_taken: () => m.save_id_taken(),
	default_required: () => m.save_default_required(),
	default_not_pickable: () => m.save_default_not_pickable(),
	invalid: (e) => m.save_invalid({ detail: e.detail }),
	header_invalid: (e) => m.mcp_header_invalid({ header: e.header }),
	header_twice: (e) => m.mcp_header_twice({ header: e.header }),
	header_value_missing: (e) => m.mcp_header_value_missing({ header: e.header }),
	default_model_not_allowed: (e) =>
		m.save_default_model_not_allowed({ model: e.model }),
	thinking_default_not_allowed: (e) =>
		m.save_thinking_default_not_allowed({ level: e.level }),
};

/** A field error of a /console save, in the User's language. */
export const saveErrorText = (error: SaveError): string =>
	// the map is keyed by code, so its entry takes this error
	(texts[error.code] as (error: SaveError) => string)(error);

/** Every field error of a save, translated, by field. */
export const saveErrorTexts = (errors: SaveErrors) =>
	Object.fromEntries(
		Object.entries(errors).map(([field, e]) => [field, saveErrorText(e)]),
	);
