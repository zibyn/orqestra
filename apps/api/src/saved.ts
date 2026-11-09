import type { SaveErrors } from "@orqestra/config/shared";
import { status } from "elysia";

/** A save's result: 422 with its field errors when it was not saved. */
export const saved = <R extends { errors: SaveErrors }>(result: R) =>
	Object.keys(result.errors).length
		? status(422, { errors: result.errors })
		: result;
