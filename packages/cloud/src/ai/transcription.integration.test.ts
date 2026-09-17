import { expect, test } from "bun:test";
import { sql } from "bun";
import { runAiTranscription } from "./transcription";

const enabled = process.env.CLOUD_DATABASE_TEST === "1";
const databaseUrl = new URL(process.env.DATABASE_URL ?? "postgres://localhost/unconfigured");
if (enabled && !(["localhost", "127.0.0.1"].includes(databaseUrl.hostname) && databaseUrl.pathname === "/cloud_authorization_test")) {
  throw new Error("Transcription integration requires the disposable cloud_authorization_test database");
}

(enabled ? test : test.skip)("transcription failure reaches logs, trace and accounting without provider response content", async () => {
  const task = `transcription-test-${crypto.randomUUID()}`;
  const bytes = new Uint8Array(44);
  bytes.set(new TextEncoder().encode("RIFFxxxxWAVE"));
  let traceId: string | undefined;
  try {
    await expect(
      runAiTranscription({
        task,
        file: new Blob([bytes]),
        filename: "test.wav",
        resolveModel: async () => ({
          profile: {
            id: "diagnostic",
            label: "Diagnostic",
            provider: "openai-compatible",
            model: "test",
            enabled: true,
            capabilities: ["transcription"],
            dataBoundary: "private",
          },
          provider: {
            name: "diagnostic",
            model: "test",
            transcribe: async () => {
              throw new Error("openai-compatible 404: PRIVATE_SOURCE_SENTINEL");
            },
          },
        }),
      }),
    ).rejects.toThrow("Audio provider HTTP 404");
    const [run] = await sql`SELECT trace_id, error_code, error FROM ai.structured_runs WHERE task = ${task}`;
    traceId = run?.trace_id;
    expect(traceId).toBeTruthy();
    expect(run.error_code).toBe("transcription_http_404");
    // The existing logger is asynchronous and stores metadata through its JSON codec.
    const pattern = `%${traceId}%`;
    let entries = await sql`SELECT message, metadata FROM logging.entries WHERE metadata::text LIKE ${pattern}`;
    for (let attempt = 0; !entries.length && attempt < 20; attempt++) {
      await Bun.sleep(50);
      entries = await sql`SELECT message, metadata FROM logging.entries WHERE metadata::text LIKE ${pattern}`;
    }
    const spans = await sql<
      { status: string; status_message: string | null }[]
    >`SELECT status, status_message FROM logging.trace_spans WHERE trace_id = ${traceId!}`;
    expect(entries.length).toBe(1);
    expect(spans.some((span) => span.status === "error")).toBe(true);
    expect(JSON.stringify({ run, entries, spans })).not.toContain("PRIVATE_SOURCE_SENTINEL");
  } finally {
    // Recover the trace even when the assertion fails before reading the run.
    if (!traceId) {
      const [run] = await sql<{ trace_id: string | null }[]>`SELECT trace_id FROM ai.structured_runs WHERE task = ${task}`;
      traceId = run?.trace_id ?? undefined;
    }
    if (traceId) {
      await sql`DELETE FROM logging.entries WHERE metadata::text LIKE ${`%${traceId}%`}`;
      await sql`DELETE FROM logging.trace_events WHERE trace_id = ${traceId}`;
      await sql`DELETE FROM logging.trace_spans WHERE trace_id = ${traceId}`;
    }
    await sql`DELETE FROM ai.structured_runs WHERE task = ${task}`;
  }
});
