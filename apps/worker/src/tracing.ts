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
 * `shutdown` flushes what is still queued; a backend that cannot be reached only loses spans.
 */
export function tracing(env: Record<string, string | undefined>) {
	// shortcut: content capture is always off until OTEL_INSTRUMENTATION_GENAI_CAPTURE_CONTENT is read (#113)
	const captureContent = false;
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
		telemetry: otelTelemetry(provider.getTracer("orqestra-worker")),
		captureContent,
		shutdown: () => provider.shutdown(),
	};
}

/** The OTel context of each span the adapter started, for links. */
const contexts = new WeakMap<TelemetryContext, SpanContext>();

/** pi's telemetry contract on an OTel tracer, its `pi.ai.request` spans renamed and mapped to the GenAI conventions. */
export function otelTelemetry(tracer: Tracer): TelemetryContext {
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
				startSpan: starter(
					tracer,
					remote && trace.wrapSpanContext(remote),
					propagation,
				),
			};
			// so a span can link to it
			if (remote) contexts.set(context, remote);
			return context;
		},
	};
	return { propagation, startSpan: starter(tracer, undefined, propagation) };
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
function starter(
	tracer: Tracer,
	parent: Span | undefined | null,
	propagation: TelemetryPropagation,
) {
	return <T>(
		options: SpanOptions,
		callback: (span: TelemetrySpan) => T | Promise<T>,
	): Promise<T> => {
		const request = options.name === "pi.ai.request";
		const otel =
			parent === null
				? null
				: tracer.startSpan(
						request ? `chat ${options.attributes?.model}` : options.name,
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
				starter(tracer, settled ? null : otel, propagation)(o, cb),
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
					? requestError(s.error?.message ?? "")
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
	};
}

/** A failed Model request's category, from the error text pi gives, with the HTTP status code in it; the text itself goes. */
function requestError(text: string) {
	const code = Number(text.match(/\b([45]\d\d)\b/)?.[1]) || undefined;
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
	return { type, code, message: undefined };
}
