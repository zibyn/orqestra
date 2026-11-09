import type { SaveErrors } from "@orqestra/config/shared";
import { status } from "elysia";

/** A save's result as it is: 200 when saved (its errors empty), 422 when not. */
export const saved = <R extends { errors: SaveErrors }>(result: R) =>
	Object.keys(result.errors).length ? status(422, result) : result;
