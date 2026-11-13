import type { SkillError } from "@orqestra/skills/shared";
import { status } from "elysia";

/** Why a field of a save was refused, as a code the console translates; `detail` is zod's message for `invalid`. */
export type SaveError =
	| {
			code:
				| "api_key_required"
				| "token_required"
				| "not_in_catalog"
				| "model_not_enabled"
				| "not_found"
				| "id_invalid"
				| "id_taken"
				| "default_required"
				| "default_not_pickable"
				| "server_disabled"
				| "connection_exists"
				| "oauth_client_required";
	  }
	| SkillError
	| { code: "invalid" | "oauth_unavailable"; detail: string }
	| {
			code:
				| "header_invalid"
				| "header_twice"
				| "header_value_missing"
				| "header_reserved";
			header: string;
	  };

/** Field errors by name or path (`apiKey`, …; "" for the whole form); empty when it was saved. */
export type SaveErrors = Record<string, SaveError>;

/** A save's result as it is: 200 when saved (its errors empty), 422 when not. */
export const saved = <R extends { errors: SaveErrors }>(result: R) =>
	Object.keys(result.errors).length ? status(422, result) : result;
