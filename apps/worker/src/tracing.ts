import type {
	AssistantMessage,
	Context,
	ImageContent,
	TextContent,
	ThinkingContent,
	ToolCall,
} from "@earendil-works/pi-ai";
import {
	NOOP_TELEMETRY_CONTEXT,
	type SpanAttributes,
	type SpanLink,
	type SpanOptions,
	type SpanStatus,
	type TelemetryContext,
	type TelemetryPropagation,
	type TelemetrySpan,
} from "@earendil-works/pi-telemetry";
import {
	type Attributes,
	isSpanContextValid,
	ROOT_CONTEXT,
	type Span,
	type SpanContext,
	SpanStatusCode,
	type Tracer,
	trace,
} from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import {
	defaultResource,
	detectResources,
	envDetector,
	resourceFromAttributes,
} from "@opentelemetry/resources";
import { BatchSpanProcessor, TracerProvider } from "@opentelemetry/sdk-trace";

/**
 * The worker's tracer, from the environment: Run traces go over OTLP/HTTP (protobuf) once OTEL_EXPORTER_OTLP_ENDPOINT or
 * OTEL_EXPORTER_OTLP_TRACES_ENDPOINT is set, nowhere otherwise. The SDK reads the headers, the timeout and OTEL_SERVICE_NAME itself.
 * With `captureContent`, spans also carry what was said: messages, Tool arguments and results, error text.
 * `shutdown` flushes what is still queued; a backend that cannot be reached only loses spans.
 */
export function tracing(env: Record<string, string | undefined>) {
	// only span attributes carry content: EVENT_ONLY, NO_CONTENT and anything else is off
	const captureContent = ["true", "SPAN_ONLY", "SPAN_AND_EVENT"].includes(
		env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_CONTENT ?? "",
	);
	if (
		!env.OTEL_EXPORTER_OTLP_ENDPOINT &&
		!env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
	)
		return {
			telemetry: NOOP_TELEMETRY_CONTEXT,
			captureContent,
			shutdown: async () => {},
		};
	const provider = new TracerProvider({
		resource: defaultResource()
			.merge(resourceFromAttributes({ "service.name": "orqestra-worker" }))
			.merge(detectResources({ detectors: [envDetector] })),
		spanProcessors: [
			new BatchSpanProcessor({ exporter: new OTLPTraceExporter() }),
		],
	});
	return {
		telemetry: otelTelemetry(
			provider.getTracer("orqestra-worker"),
			captureContent,
		),
		captureContent,
		shutdown: () => provider.shutdown(),
	};
}

/** The OTel context of each span the adapter started, for links. */
const contexts = new WeakMap<TelemetryContext, SpanContext>();

/**
 * pi's telemetry contract on an OTel tracer, its `pi.ai.request` spans renamed and each pi span mapped to the GenAI conventions;
 * a failed request keeps its error text only with `captureContent`.
 */
export function otelTelemetry(
	tracer: Tracer,
	captureContent = false,
): TelemetryContext {
	// W3C trace context, so a Run in another job, or another worker, continues or links to a span of this one
	const propagation: TelemetryPropagation = {
		inject: (context) => {
			const c = contexts.get(context);
			return (
				c && {
					traceparent: `00-${c.traceId}-${c.spanId}-${c.traceFlags.toString(16).padStart(2, "0")}`,
				}
			);
		},
		extract: (carrier) => {
			const m = carrier?.traceparent?.match(
				/^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/,
			);
			const found: SpanContext | undefined = m
				? {
						traceId: m[1] as string,
						spanId: m[2] as string,
						traceFlags: Number.parseInt(m[3] as string, 16),
						isRemote: true,
					}
				: undefined;
			const remote = found && isSpanContextValid(found) ? found : undefined;
			const context: TelemetryContext = {
				propagation,
				startSpan: spansUnder(
					tracer,
					remote && trace.wrapSpanContext(remote),
					propagation,
					captureContent,
				),
			};
			// so a span can link to it
			if (remote) contexts.set(context, remote);
			return context;
		},
	};
	return {
		propagation,
		startSpan: spansUnder(tracer, undefined, propagation, captureContent),
	};
}

const clean = (attributes: SpanAttributes = {}): Attributes =>
	Object.fromEntries(
		Object.entries(attributes)
			.filter(([, v]) => v !== undefined)
			.map(([k, v]) => [k, Array.isArray(v) ? [...v] : v]),
	);

const links = (list: readonly SpanLink[] = []) =>
	list.flatMap((l) => {
		const context = contexts.get(l.context);
		return context ? [{ context, attributes: clean(l.attributes) }] : [];
	});

/** Starts children of `parent` (roots when undefined); `null` makes inert ones, the children of a settled span. */
function spansUnder(
	tracer: Tracer,
	parent: Span | undefined | null,
	propagation: TelemetryPropagation,
	captureContent: boolean,
) {
	return <T>(
		options: SpanOptions,
		callback: (span: TelemetrySpan) => T | Promise<T>,
	): Promise<T> => {
		// pi's spans (a request, a poll) carry cost and error text: each goes through the GenAI mapping
		const request = options.name.startsWith("pi.");
		const otel =
			parent === null
				? null
				: tracer.startSpan(
						options.name === "pi.ai.request"
							? `chat ${options.attributes?.model}`
							: options.name,
						{
							attributes: clean(
								request ? requestStart(options.attributes) : options.attributes,
							),
							links: links(options.links),
						},
						parent ? trace.setSpan(ROOT_CONTEXT, parent) : ROOT_CONTEXT,
					);
		let settled = otel === null;
		let status: SpanStatus | undefined;
		const span: TelemetrySpan = {
			propagation,
			startSpan: (o, cb) =>
				spansUnder(
					tracer,
					settled ? null : otel,
					propagation,
					captureContent,
				)(o, cb),
			addLink: (link) => {
				if (!settled) otel?.addLinks(links([link]));
			},
			addEvent: (name, attributes) => {
				if (!settled) otel?.addEvent(name, clean(attributes));
			},
			setAttributes: (attributes) => {
				if (!settled)
					otel?.setAttributes(
						clean(request ? requestEnd(attributes) : attributes),
					);
			},
			setStatus: (s) => {
				if (!settled) status = s;
			},
		};
		if (otel) contexts.set(span, otel.spanContext());
		const settle = (thrown: boolean) => {
			if (settled || !otel) return;
			settled = true;
			const s: SpanStatus =
				status ?? (thrown ? { status: "error" } : { status: "ok" });
			if (s.status === "error") {
				// pi puts up to 500 characters of the Provider's error text there, which may echo the prompt
				const { type, code, message } = request
					? requestError(s.error?.message ?? "", captureContent)
					: { type: s.error?.name ?? "_OTHER", message: s.error?.message };
				otel.setAttributes(
					clean({ "error.type": type, "http.response.status_code": code }),
				);
				otel.setStatus({ code: SpanStatusCode.ERROR, message });
			}
			otel.end();
		};
		let result: T | Promise<T>;
		try {
			result = callback(span);
		} catch (error) {
			settle(true);
			return Promise.reject(error);
		}
		return Promise.resolve(result).then(
			(value) => {
				settle(false);
				return value;
			},
			(error) => {
				settle(true);
				throw error;
			},
		);
	};
}

// pi.ai.request in the OpenTelemetry GenAI conventions; pi's cost.total is left out, Usage being the one cost
function requestStart({
	provider,
	model,
	api: _api,
	reasoning: _reasoning,
	...rest
}: SpanAttributes = {}): SpanAttributes {
	return {
		...rest,
		"gen_ai.operation.name": "chat",
		"gen_ai.provider.name": provider,
		"gen_ai.request.model": model,
	};
}

function requestEnd(a: SpanAttributes): SpanAttributes {
	const tokens = (name: string) =>
		typeof a[name] === "number" ? (a[name] as number) : 0;
	return {
		"gen_ai.response.finish_reasons":
			typeof a.stop === "string" ? [a.stop] : undefined,
		// the conventions count cached input in the input tokens, pi apart
		"gen_ai.usage.input_tokens":
			a["usage.input"] === undefined
				? undefined
				: tokens("usage.input") +
					tokens("usage.cache_read") +
					tokens("usage.cache_write"),
		"gen_ai.usage.output_tokens": a["usage.output"],
		"gen_ai.usage.cache_read.input_tokens": a["usage.cache_read"],
		"gen_ai.usage.cache_creation.input_tokens": a["usage.cache_write"],
		"gen_ai.response.id": a["response.id"],
		"gen_ai.output.messages": a["gen_ai.output.messages"],
	};
}

/**
 * A failed Model request's category, from the error text pi gives (no structured status), with the HTTP status code
 * when the text leads with one or names it ("status 429", "HTTP 429"); the text goes unless captured.
 */
function requestError(text: string, captureContent: boolean) {
	const m = text.match(
		/^\s*([45]\d\d)\b|\b(?:status(?: code)?|HTTP)[\s:]+([45]\d\d)\b/i,
	);
	const code = Number(m?.[1] ?? m?.[2]) || undefined;
	const type =
		code === 401 || code === 403 || /unauthori[sz]ed|api key/i.test(text)
			? "authentication"
			: code === 429 || /rate limit/i.test(text)
				? "rate_limited"
				: /context (length|window)|too long|maximum context/i.test(text)
					? "context_length_exceeded"
					: code === 408 || /time(d)? ?out/i.test(text)
						? "timeout"
						: code !== undefined && code >= 500
							? "server_error"
							: "_OTHER";
	return { type, code, message: captureContent ? text : undefined };
}

const parts = (
	content: string | (TextContent | ThinkingContent | ToolCall | ImageContent)[],
) =>
	typeof content === "string"
		? [{ type: "text", content }]
		: content.map((p) =>
				p.type === "text"
					? { type: "text", content: p.text }
					: p.type === "thinking"
						? { type: "reasoning", content: p.thinking }
						: p.type === "toolCall"
							? {
									type: "tool_call",
									id: p.id,
									name: p.name,
									arguments: p.arguments,
								}
							: // shortcut: images go without their data, add it as a blob part if a backend needs to show them
								{ type: "blob", modality: "image", mime_type: p.mimeType },
			);

/** A Model request's input in the GenAI conventions: the system messages as instructions, the rest as messages. */
export function inputContent({ systemPrompt, messages }: Context) {
	return {
		"gen_ai.system_instructions": JSON.stringify([
			...(systemPrompt ? [{ type: "text", content: systemPrompt }] : []),
			...messages.flatMap((m) =>
				m.role === "system"
					? [
							...parts(m.content),
							...Object.values(m.sections ?? {}).flatMap((s) =>
								s === null ? [] : [{ type: "text", content: s }],
							),
						]
					: [],
			),
		]),
		"gen_ai.input.messages": JSON.stringify(
			messages.flatMap((m) =>
				m.role === "system"
					? []
					: [
							m.role === "toolResult"
								? {
										role: "tool",
										parts: [
											{
												type: "tool_call_response",
												id: m.toolCallId,
												response: parts(m.content),
											},
										],
									}
								: { role: m.role, parts: parts(m.content) },
						],
			),
		),
	};
}

/** A Model request's answer in the GenAI conventions. */
export const outputContent = (message: AssistantMessage) =>
	JSON.stringify([
		{
			role: "assistant",
			parts: parts(message.content),
			finish_reason: message.stopReason,
		},
	]);
