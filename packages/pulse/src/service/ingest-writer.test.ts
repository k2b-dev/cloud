import { describe, expect, test } from "bun:test";

const { ingestBatch } = await import("./ingest-writer");

test("completed receipt validity includes generation and both checkpoint phases", async () => {
  const { completedIngestResponse } = await import("./ingest-writer");
  const checkpoint = { reset_generation: "9007199254740993", checkpoint_id: "committed", pending_checkpoint_id: "pending" };
  const receipt = { ...checkpoint, state: "done" as const, response: { metrics: 1, events: 2, states: 3 } };
  expect(completedIngestResponse(receipt, checkpoint)).toEqual(receipt.response);
  for (const change of [
    { reset_generation: "9007199254740992" },
    { reset_generation: null }, // A receipt written before migration 8 must replay.
    { checkpoint_id: "older" },
    { pending_checkpoint_id: null },
    { state: "pending" as const },
    { response: null },
  ])
    expect(completedIngestResponse({ ...receipt, ...change }, checkpoint)).toBeNull();
  const empty = { reset_generation: "0", checkpoint_id: null, pending_checkpoint_id: null };
  expect(completedIngestResponse({ ...receipt, ...empty }, empty)).toEqual(receipt.response);
});

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

test("#1310 names every future item with a frozen five-minute boundary", async () => {
  const { validateIngestTimestamps, createIngestWriter } = await import("./ingest-writer");
  const now = new Date("2026-10-17T12:00:00.000Z");
  const writer = createIngestWriter({ clock: () => now });
  for (const collection of ["metrics", "events", "states"] as const) {
    const item =
      collection === "metrics" ? { name: "load", value: 1 } : collection === "events" ? { kind: "opened" } : { key: "door", value: true };
    for (const seconds of [299, 300, 301]) {
      const batch = { [collection]: [{ ...item, ts: new Date(now.getTime() + seconds * 1000).toISOString() }] };
      const result = validateIngestTimestamps(batch, now);
      expect(result.ok).toBe(seconds <= 300);
      if (!result.ok) expect(result.error.message).toContain(`${collection}[0]`);
    }
  }
  const future = await writer({
    baseId: "11111111-1111-4111-8111-111111111111",
    sourceId: "22222222-2222-4222-8222-222222222222",
    batch: { states: [{ key: "door", value: true, ts: "2099-01-01T00:00:00Z" }] },
  });
  expect(future).toMatchObject({
    ok: false,
    error: { status: 400, message: 'states[0] (key "door") has timestamp 2099-01-01T00:00:00.000Z, more than 5 minutes in the future' },
  });
});
