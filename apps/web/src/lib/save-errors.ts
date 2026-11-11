import type { SaveError, SaveErrors } from "@orqestra/config/shared";
import { m } from "#/paraglide/messages";

type Code = SaveError["code"];
const texts: {
	[C in Code]: (error: SaveError & { code: C }) => string;
} = {
	api_key_required: () => m.api_key_required(),
	token_required: () => m.sandbox_token_required(),
	not_in_catalog: () => m.save_not_in_catalog(),
	model_not_enabled: () => m.save_model_not_enabled(),
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
	skill_zip_invalid: () => m.skill_zip_invalid(),
	skill_md_missing: () => m.skill_md_missing(),
	skill_frontmatter_invalid: () => m.skill_frontmatter_invalid(),
	skill_name_invalid: () => m.skill_name_invalid(),
	skill_name_mismatch: (e) =>
		m.skill_name_mismatch({ name: e.name, folder: e.folder }),
	skill_description_invalid: () => m.skill_description_invalid(),
	skill_too_large: () => m.skill_too_large(),
	skill_too_many_files: () => m.skill_too_many_files(),
	skill_path_unsafe: (e) => m.skill_path_unsafe({ path: e.path }),
	skill_symlink: (e) => m.skill_symlink({ path: e.path }),
	skill_path_duplicate: (e) => m.skill_path_duplicate({ path: e.path }),
	skill_md_nested: (e) => m.skill_md_nested({ path: e.path }),
	skill_file_binary: (e) => m.skill_file_binary({ path: e.path }),
	skill_exists: () => m.skill_exists(),
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

/** The first field error of a save, translated; undefined when it was saved. */
export const firstError = (result: { errors: SaveErrors }) =>
	Object.values(saveErrorTexts(result.errors))[0];

type Response<T> =
	| { data: T; error: null }
	| { data: null; error: { status: unknown; value: unknown } };

/** A save's result, its field errors empty when it was saved: the api answers 422 with them. */
export async function saved<T extends { errors: SaveErrors }>(
	response: Promise<Response<T>>,
) {
	const { data, error } = await response;
	if (error?.status === 422) return error.value as T;
	if (error) throw error;
	return data as T;
}

/** What to show for a failed request: the first field error of an api error's body, when it has a known code. */
export function errorText(error: unknown) {
	const errors = (error as { value?: { errors?: SaveErrors } } | null)?.value
		?.errors;
	const first = errors && Object.values(errors)[0];
	if (first)
		return first.code in texts ? saveErrorText(first) : m.request_failed();
	return error instanceof Error ? error.message : m.request_failed();
}
