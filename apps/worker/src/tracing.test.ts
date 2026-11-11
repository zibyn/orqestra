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
