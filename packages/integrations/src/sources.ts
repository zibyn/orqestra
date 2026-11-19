// Every WorkSource Orqestra serves (ADR 0020): the api routes, and the worker serves, each of them in turn.
import { linear } from "./linear/index.ts";
import type { IntegrationKind, WorkSource } from "./ports.ts";

export const sources: WorkSource[] = [linear];

/** The WorkSource of a kind; undefined for one Orqestra no longer serves. */
export const sourceOf = (kind: IntegrationKind) =>
	sources.find((source) => source.kind === kind);
