import { expect, test } from "bun:test";
import { natsMetricSamples } from "./metrics";
import type { NatsDiagnostics, NatsInventorySummary, NatsStream } from "./service";

const cluster: NatsDiagnostics["cluster"] = { status: "not_configured", nodes: [] };
const stream: NatsStream = {
  name: "S6_JD_example",
  kind: "stream",
  storage: "file",
  messages: 3,
  bytes: 42,
  consumers: 0,
  replicas: 3,
  maxBytes: 100,
  maxMessages: -1,
  maxAgeMs: 1_000,
  deadLetter: true,
  cluster: { name: "test", leader: "a", replicas: [{ name: "b", current: true, offline: false, lag: 0 }] },
  sync: { namespace: "test", owner: "notebooks", kind: "job", id: "snapshots" },
};
const summary = (status: NatsInventorySummary["status"]): NatsInventorySummary => ({
  status,
  streams: [stream, stream],
  total: 1,
  sampledAt: new Date().toISOString(),
});

test("incomplete inventory never exposes a misleading zero or partial fleet total", () => {
  const samples = natsMetricSamples(cluster, summary("partial"));
  expect(samples.find((item) => item.name === "cloud_nats_inventory_up")?.value).toBe(0);
  expect(samples.some((item) => item.name.startsWith("cloud_sync_"))).toBe(false);
  expect(samples.some((item) => item.name === "cloud_nats_account_streams")).toBe(false);
});

test("logical streams are counted once and missing followers remain unhealthy", () => {
  const samples = natsMetricSamples(cluster, summary("available"));
  expect(samples.find((item) => item.name === "cloud_sync_dead_letters")?.value).toBe(3);
  expect(samples.find((item) => item.name === "cloud_nats_account_storage_bytes")?.value).toBe(42);
  expect(samples.find((item) => item.name === "cloud_sync_streams_replication_unhealthy")?.value).toBe(1);
  expect(samples.find((item) => item.name === "cloud_sync_streams")?.labels).toEqual({
    namespace: "test",
    owner: "notebooks",
    kind: "job",
  });
});

test("healthy empty inventory publishes account zeros and no invented resource groups", () => {
  const samples = natsMetricSamples(cluster, { ...summary("available"), total: 0, streams: [] });
  expect(samples.find((item) => item.name === "cloud_nats_account_streams")?.value).toBe(0);
  expect(samples.find((item) => item.name === "cloud_nats_inventory_up")?.value).toBe(1);
  expect(samples.some((item) => item.name.startsWith("cloud_sync_"))).toBe(false);
});
