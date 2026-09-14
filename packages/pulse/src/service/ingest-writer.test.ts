import { describe, expect, test } from "bun:test";

const { ingestBatch } = await import("./ingest-writer");

describe("Pulse ingest writer", () => {
  test("rejects a mixed batch with an invalid later item before opening a transaction", async () => {
    const result = await ingestBatch({
      baseId: "103546c5-be8f-47e3-9239-a27c70b47abc",
      sourceId: "6c18f8db-e778-41a5-8517-7cd89cb552d6",
      batch: {
        metrics: [{ name: "system.cpu.usage", value: 12, type: "gauge" }],
        states: [{ key: "system.online", value: true, ts: "not a timestamp" }],
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("BAD_INPUT");
    expect(result.error.message).toBe("Invalid timestamp");
  });

  test("rejects excessive event dimensions before opening a transaction", async () => {
    const result = await ingestBatch({
      baseId: "103546c5-be8f-47e3-9239-a27c70b47abc",
      sourceId: "6c18f8db-e778-41a5-8517-7cd89cb552d6",
      batch: {
        events: [
          {
            kind: "page.viewed",
            dimensions: Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`key_${index}`, `value_${index}`])),
          },
        ],
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toBe("Dimensions cannot exceed 32 keys");
  });

  test("runs full validation for direct metric, event, and state writers before SQL", async () => {
    const baseId = "103546c5-be8f-47e3-9239-a27c70b47abc";

    const metric = await ingestBatch({
      baseId,
      sourceId: "00000000-0000-4000-8000-000000000001",
      batch: {
        metrics: [
          {
            name: "system.cpu",
            value: 1,
            dimensions: Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`key_${index}`, "value"])),
          },
        ],
      },
    });
    const event = await ingestBatch({
      baseId,
      sourceId: "00000000-0000-4000-8000-000000000001",
      batch: { events: [{ kind: "page.viewed", value: Number.POSITIVE_INFINITY }] },
    });
    const state = await ingestBatch({
      baseId,
      sourceId: "00000000-0000-4000-8000-000000000001",
      batch: { states: [{ key: "system.load", value: Number.NaN }] },
    });

    expect(metric).toMatchObject({ ok: false, error: { code: "BAD_INPUT", message: "Dimensions cannot exceed 32 keys" } });
    expect(event).toMatchObject({ ok: false, error: { code: "BAD_INPUT", message: "Event value must be finite" } });
    expect(state).toMatchObject({ ok: false, error: { code: "BAD_INPUT", message: "State value must be finite" } });
  });
});
