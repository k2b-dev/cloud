import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { err, fail, ok } from "@valentinkolb/cloud/server";
import { sql } from "bun";
import { newShortId } from "../lib/short-id";
import { runMetricsSourceScrape } from "./metrics-scraper";

const enabled = process.env.PULSE_METRICS_SCRAPER_DB_TEST === "1";
const postgresTest = enabled ? test : test.skip;

let endpoint: ReturnType<typeof Bun.serve> | undefined;
let baseId = "";
let sourceId = "";

beforeAll(async () => {
  if (!enabled) return;
  const { migrate } = await import("../migrate");
  await migrate();
  endpoint = Bun.serve({
    port: 0,
    fetch: () => new Response("# TYPE scrape_probe gauge\nscrape_probe 1\n", { headers: { "content-type": "text/plain" } }),
  });
  baseId = crypto.randomUUID();
  sourceId = crypto.randomUUID();
  await sql`INSERT INTO pulse.bases (id, short_id, name) VALUES (${baseId}::uuid, ${newShortId()}, 'Scraper outcome smoke')`;
  await sql`
    INSERT INTO pulse.sources (id, short_id, base_id, kind, name, endpoint_url)
    VALUES (${sourceId}::uuid, ${newShortId()}, ${baseId}::uuid, 'metrics'::pulse.source_kind, 'Probe', ${`http://127.0.0.1:${endpoint.port}/metrics`})
  `;
}, 60_000);

afterAll(async () => {
  if (baseId) await sql`DELETE FROM pulse.bases WHERE id = ${baseId}::uuid`;
  endpoint?.stop(true);
});

const lastError = async (): Promise<string | null> => {
  const [row] = await sql<{ last_error: string | null }[]>`SELECT last_error FROM pulse.sources WHERE id = ${sourceId}::uuid`;
  return row?.last_error ?? null;
};

describe("metrics scrape outcomes", () => {
  postgresTest("records endpoint and input failures as scrape outcomes but throws on ingest infrastructure failures", async () => {
    const rejected = await runMetricsSourceScrape(
      { baseId, sourceId },
      { ingestBatch: async () => fail(err.badInput("Metric series limit reached")) },
    );
    expect(rejected).toMatchObject({ ok: false, error: { status: 400 } });
    expect(await lastError()).toBe("Metric series limit reached");

    await expect(
      runMetricsSourceScrape({ baseId, sourceId }, { ingestBatch: async () => fail(err.internal("Failed to ingest Pulse batch")) }),
    ).rejects.toThrow("Metrics ingest failed: Failed to ingest Pulse batch");
    // Infrastructure failures are left to the job retry; the source keeps its last real outcome.
    expect(await lastError()).toBe("Metric series limit reached");

    const accepted = await runMetricsSourceScrape(
      { baseId, sourceId },
      { ingestBatch: async ({ batch }) => ok({ metrics: batch.metrics?.length ?? 0, events: 0, states: 0 }) },
    );
    expect(accepted).toEqual({ ok: true, data: { metrics: 1, events: 0, states: 0 } });
    expect(await lastError()).toBeNull();

    endpoint?.stop(true);
    const unreachable = await runMetricsSourceScrape(
      { baseId, sourceId },
      { ingestBatch: async () => ok({ metrics: 0, events: 0, states: 0 }) },
    );
    expect(unreachable.ok).toBe(false);
    expect(await lastError()).not.toBeNull();
  });
});
