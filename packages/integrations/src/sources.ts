// Every WorkSource Orqestra serves (ADR 0020): the api routes, and the worker serves, each of them in turn.
import { email } from "./email/index.ts";
import { feishu } from "./feishu/index.ts";
import { github } from "./github/index.ts";
import { linear } from "./linear/index.ts";
import type { IntegrationKind, WorkSource } from "./ports.ts";
import { wecom } from "./wecom/index.ts";

export const sources: WorkSource[] = [linear, github, feishu, wecom, email];

/** The WorkSource of a kind; undefined for one Orqestra no longer serves. */
export const sourceOf = (kind: IntegrationKind) =>
	sources.find((source) => source.kind === kind);
