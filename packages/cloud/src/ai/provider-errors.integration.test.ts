import { expect, spyOn } from "bun:test";
import { memoryStore, nessi, type Provider } from "@k2b/nessi";
import { sql } from "bun";
import { z } from "zod";
import { testFor } from "../../../../scripts/fixtures/test-infra";
import "../../../../scripts/fixtures/authorization-preload";
import { logger, trace } from "../services/logging";
import { createAiProvider } from "./provider";
import { withProviderErrors } from "./provider-errors";
import { inferenceProvider } from "./quota-provider";
import { runAiStructured } from "./structured";
import type { AiModelProfile } from "./types";

const marker = "FICTIONAL_INVOICE_4711_PROVIDER_CANARY";
for (const kind of ["provider-message", "provider-body", "nested-error", "schema", "tool-loop"] as const) {
  testFor("database")(`AI diagnostics exclude provider content: ${kind}`, async () => {
    const task = `provider-test-${crypto.randomUUID()}`;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () =>
        Response.json(kind === "provider-body" ? { detail: [{ input: marker }] } : { error: { message: marker, code: marker } }, {
          status: 422,
        }),
    });
    const profile: AiModelProfile = {
      modelId: "fixture",
      providerId: "fixture",
      variantLabel: "Standard",
      description: "",
      icon: { kind: "provider" },
      showInPicker: true,
      id: "fixture",
      label: "Fixture",
      provider: "openai-compatible",
      model: "fixture",
      enabled: true,
      capabilities: ["tools"],
      dataBoundary: "private",
      baseURL: `${server.url}v1`,
    };
    let provider: Provider = createAiProvider(profile);
    if (kind === "nested-error" || kind === "schema")
      provider = withProviderErrors({
        ...provider,
        complete: async () => {
          if (kind === "nested-error")
            throw Object.assign(new Error(marker, { cause: { input: marker } }), { name: marker, code: marker, stack: marker });
          return {
            message: { role: "assistant", content: [{ type: "text", text: JSON.stringify({ number: { invalid: marker } }) }] },
            finishReason: "stop",
          };
        },
      });
    const output: unknown[] = [];
    const consoleError = spyOn(console, "error").mockImplementation((...args) => {
      output.push(args);
    });
    const consoleWarn = spyOn(console, "warn").mockImplementation((...args) => {
      output.push(args);
    });
    const source = `ai:test:${task}`;
    const log = logger(source);
    let traceId: string | undefined;
    try {
      if (kind === "tool-loop") {
        await trace.withSpan({ name: task, source, category: "ai" }, async (span) => {
          traceId = span.traceId;
          const loop = nessi({
            provider: inferenceProvider(provider, profile, { kind: "background", task, traceId }),
            input: "Fictional input",
            systemPrompt: "Use only fictional fixtures.",
            store: memoryStore(),
          });
          let issues = 0;
          for await (const event of loop) {
            if (event.type === "issue") {
              issues++;
              log.warn("AI turn issue", { kind: event.issue.kind, message: event.issue.message });
              await trace.record({ context: span, event: "issue", attributes: { message: event.issue.message } });
            }
          }
          expect(issues).toBeGreaterThan(0);
        });
      } else {
        let failure: unknown;
        try {
          await runAiStructured({
            task,
            input: marker,
            output: z.object({ number: z.string() }),
            resolveModel: async () => ({ model: { id: profile.id }, profile, provider }),
          });
        } catch (error) {
          failure = error;
          log.error("AI task failed", { error: error instanceof Error ? error.message : String(error) });
        }
        expect(failure).toBeInstanceOf(Error);
        const [run] = await sql`SELECT * FROM ai.structured_runs WHERE task=${task}`;
        traceId = run?.trace_id;
        expect(run?.status).toBe("failed");
        expect(run?.error_code).toBe(kind === "schema" ? "invalid_output" : "provider_error");
      }
      expect(traceId).toBeTruthy();
      const deadline = Date.now() + 5_000;
      let entries = await sql`SELECT * FROM logging.entries WHERE source=${source}`;
      while (!entries.length && Date.now() < deadline) {
        await Bun.sleep(20);
        entries = await sql`SELECT * FROM logging.entries WHERE source=${source}`;
      }
      const runs = await sql`SELECT * FROM ai.structured_runs WHERE task=${task}`;
      const calls = await sql`SELECT * FROM ai.inference_calls WHERE task=${task}`;
      const spans = await sql`SELECT * FROM logging.trace_spans WHERE trace_id=${traceId!}`;
      const events = await sql`SELECT * FROM logging.trace_events WHERE trace_id=${traceId!}`;
      expect(entries.length).toBeGreaterThan(0);
      expect(calls.length).toBeGreaterThan(0);
      expect(spans.length).toBeGreaterThan(0);
      expect(events.length).toBeGreaterThan(0);
      expect(JSON.stringify({ runs, calls, spans, events, entries, output })).not.toContain(marker);
    } finally {
      consoleError.mockRestore();
      consoleWarn.mockRestore();
      server.stop(true);
      await sql`DELETE FROM logging.entries WHERE source=${source}`;
      if (traceId) {
        await sql`DELETE FROM logging.trace_events WHERE trace_id=${traceId}`;
        await sql`DELETE FROM logging.trace_spans WHERE trace_id=${traceId}`;
      }
      await sql`DELETE FROM ai.structured_runs WHERE task=${task}`;
      await sql`DELETE FROM ai.inference_calls WHERE task=${task}`;
    }
  });
}
