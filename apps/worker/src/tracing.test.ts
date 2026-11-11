import { describe, expect, it } from "bun:test";
import {
	NOOP_TELEMETRY_CONTEXT,
	type RecordedTelemetrySpan,
} from "@earendil-works/pi-telemetry";
import { createTelemetryAdapterConformance } from "@earendil-works/pi-telemetry/testing";
import type { SpanContext } from "@opentelemetry/api";
import {
	InMemorySpanExporter,
	SimpleSpanProcessor,
	TracerProvider,
} from "@opentelemetry/sdk-trace";
import { otelTelemetry, tracing } from "./tracing.ts";

describe("tracing", () => {
	it("sends nothing without an OTLP endpoint", async () => {
		const traced = tracing({});
		expect(traced.telemetry).toBe(NOOP_TELEMETRY_CONTEXT);
		expect(traced.captureContent).toBe(false);
		await traced.shutdown();
	});

	it("captures content only for true, SPAN_ONLY and SPAN_AND_EVENT", () => {
		const capture = (value?: string) =>
			tracing({ OTEL_INSTRUMENTATION_GENAI_CAPTURE_CONTENT: value })
				.captureContent;
		for (const on of ["true", "SPAN_ONLY", "SPAN_AND_EVENT"])
			expect(capture(on)).toBe(true);
		for (const off of [undefined, "NO_CONTENT", "EVENT_ONLY", "yes", "flase"])
			expect(capture(off)).toBe(false);
	});

	it("exports to either OTLP endpoint", async () => {
		for (const name of [
			"OTEL_EXPORTER_OTLP_ENDPOINT",
			"OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
		]) {
			const traced = tracing({ [name]: "http://127.0.0.1:1" });
			expect(traced.telemetry).not.toBe(NOOP_TELEMETRY_CONTEXT);
			await traced.shutdown();
		}
	});
});

describe("otelTelemetry pi spans", () => {
	// as pi's observeModelRequest reports a failed request or poll
	const failed = async (name: string, message: string) => {
		const exporter = new InMemorySpanExporter();
		const provider = new TracerProvider({
			spanProcessors: [new SimpleSpanProcessor({ exporter })],
		});
		await otelTelemetry(provider.getTracer("test")).startSpan(
			{ name, attributes: { provider: "p", model: "m", api: "x" } },
			(span) => {
				span.setAttributes({ stop: "error", "cost.total": 0.5 });
				span.setStatus({
					status: "error",
					error: { name: "provider_error", message },
				});
			},
		);
		return exporter.getFinishedSpans()[0];
	};

	it("takes an HTTP status code only from status-shaped error text", async () => {
		const code = async (message: string) =>
			(await failed("pi.ai.request", message))?.attributes[
				"http.response.status_code"
			];
		expect(await code("429 Too Many Requests")).toBe(429);
		expect(await code("Request failed with status 503")).toBe(503);
		expect(await code("HTTP 401: bad key")).toBe(401);
		expect(await code("prompt is 400 tokens over the limit")).toBeUndefined();
		expect(await code("you said: call me at 555 0100")).toBeUndefined();
	});

	it("maps a poll as a request: no cost, no error text", async () => {
		const poll = await failed("pi.ai.poll", "500 secret prompt echoed");
		expect(poll?.attributes["cost.total"]).toBeUndefined();
		expect(poll?.attributes.api).toBeUndefined();
		expect(poll?.attributes["gen_ai.request.model"]).toBe("m");
		expect(poll?.attributes["error.type"]).toBe("server_error");
		expect(poll?.status.message ?? "").not.toMatch(/secret/);
	});
});

// pi-telemetry's own checks of an adapter, against the OTel spans it ends
const traceparent = (c: SpanContext) => ({
	traceparent: `00-${c.traceId}-${c.spanId}-01`,
});
const conformance = createTelemetryAdapterConformance(async () => {
	const exporter = new InMemorySpanExporter();
	const provider = new TracerProvider({
		spanProcessors: [new SimpleSpanProcessor({ exporter })],
	});
	const context = otelTelemetry(provider.getTracer("test"));
	return {
		context,
		propagation: context.propagation,
		getSpans: async () => {
			const spans = exporter.getFinishedSpans();
			const ids = spans.map((s) => s.spanContext().spanId);
			return spans.map((s, i) => {
				const parent = s.parentSpanContext
					? ids.indexOf(s.parentSpanContext.spanId)
					: -1;
				const { "error.type": type, ...attributes } = s.attributes;
				return {
					id: i,
					parentId: parent < 0 ? null : parent,
					context: traceparent(s.spanContext()),
					parentContext: s.parentSpanContext
						? traceparent(s.parentSpanContext)
						: null,
					links: s.links.map((l) => ({
						context: traceparent(l.context),
						attributes: l.attributes ?? {},
					})),
					name: s.name,
					attributes,
					events: s.events.map((e) => ({
						name: e.name,
						attributes: e.attributes ?? {},
					})),
					status:
						s.status.code === 2
							? {
									status: "error" as const,
									error: {
										name: String(type),
										message: s.status.message ?? "",
									},
								}
							: { status: "ok" as const },
					settled: true,
					endSequence: i,
				} as RecordedTelemetrySpan;
			});
		},
		[Symbol.asyncDispose]: () => provider.shutdown(),
	};
});
describe("otelTelemetry conformance", () => {
	for (const c of conformance) it(`${c.group}: ${c.name}`, () => c.run());
});
