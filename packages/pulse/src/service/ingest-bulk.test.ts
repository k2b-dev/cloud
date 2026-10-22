import { expect, test } from "bun:test";
import { deterministicRowId, ingestVersion, prepareIngestBatch } from "./ingest-bulk";

const source = "11111111-1111-4111-8111-111111111111";
const now = new Date("2026-10-17T12:00:00.123Z");
test("a reused key gets new row identities in a later reservation while retries retain them", () => {
  const batch = { events: [{ kind: "opened", ts: now.toISOString(), value: 1 }] };
  const first = prepareIngestBatch(batch, source, now, "key");
  const later = new Date(now.getTime() + 86_400_000);
  const reused = prepareIngestBatch({ events: [{ ...batch.events[0]!, value: 2 }] }, source, later, "key");
  expect(reused.events[0]?.id).not.toBe(first.events[0]?.id);
  expect(prepareIngestBatch(batch, source, now, "key").events[0]?.id).toBe(first.events[0]?.id);
});
test("idempotent rows keep identity, acceptance time, and a batch-wide UInt64 ordinal", () => {
  const batch = { metrics: [{ name: "load", value: 1 }], events: [{ kind: "opened" }], states: [{ key: "door", value: true }] };
  const first = prepareIngestBatch(batch, source, now, "key"),
    retry = prepareIngestBatch(batch, source, now, "key");
  expect(first).toEqual(retry);
  const rows = [...first.metrics, ...first.events, ...first.states];
  expect(rows.map((r) => r.ordinal)).toEqual([0, 1, 2]);
  expect(new Set(rows.map((r) => r.id)).size).toBe(3);
  expect(rows.map((r) => r.ts)).toEqual(Array(3).fill(now.toISOString()));
  expect(rows.map((r) => r.version)).toEqual([0, 1, 2].map((n) => (BigInt(now.getTime()) * 100000n + BigInt(n)).toString()));
  expect(ingestVersion(now, 49999)).toBe((BigInt(now.getTime()) * 100000n + 49999n).toString());
  expect(deterministicRowId(source, "key", "events", 1)).not.toBe(deterministicRowId(source, "other", "events", 1));
});
test("resource identity and sorted dimensions bind metric/state variants to their source", () => {
  const metric = { name: "load", value: 1, resource: { type: "host", id: "same", label: "label" }, dimensions: { zone: "eu", a: 1 } };
  const one = prepareIngestBatch(
    { metrics: [metric], states: [{ key: "online", value: true, resource: metric.resource, dimensions: metric.dimensions }] },
    source,
    now,
    "key",
  );
  expect(one.metrics[0]?.seriesKey).toBe(one.states[0]?.variantKey);
  expect(one.metrics[0]?.dimensions).toEqual({ a: "1", zone: "eu" });
  const other = prepareIngestBatch({ metrics: [{ ...metric, resource: { type: "service", id: "same" } }] }, source, now, "key");
  expect(other.metrics[0]?.seriesKey).not.toBe(one.metrics[0]?.seriesKey);
  const unbound = prepareIngestBatch(
    {
      events: [
        {
          kind: "view",
          actorId: "visitor",
          dimensions: { host: "never-infer" },
          attributes: { geo: { city: "Berlin" } },
          sensitive: { ip: "example" },
          payload: { raw: [1] },
        },
      ],
    },
    source,
    now,
    "key",
  );
  expect(unbound.events[0]?.resourceKey).toBeNull();
  expect(unbound.events[0]?.payload).toEqual({ raw: [1] });
});
