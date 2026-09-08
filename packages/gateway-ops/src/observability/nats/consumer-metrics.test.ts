import { expect, spyOn, test } from "bun:test";
import { getNatsConsumerMetricSamples } from "./consumer-metrics";
import type { NatsDiagnosticsDependencies, NatsInventorySummary, NatsStream } from "./service";

const config = { application: { servers: ["nats://app"] }, admin: { servers: ["nats://system"] } };
const stream = (name: string): NatsStream => ({
  name,
  kind: "stream",
  storage: "file",
  messages: 99999,
  bytes: 20,
  consumers: 2,
  replicas: 3,
  maxBytes: -1,
  maxMessages: -1,
  maxAgeMs: 1000,
  deadLetter: false,
  cluster: null,
  sync: { namespace: "test", owner: "notebooks", kind: "topic", id: `note-${name}` },
});
const inventory = (...names: string[]): NatsInventorySummary => ({
  status: "available",
  total: names.length,
  streams: names.map(stream),
  sampledAt: new Date().toISOString(),
});
const consumer = (name: string) => ({ name, num_pending: 3, num_ack_pending: 2, num_redelivered: 1 });
const fake = (reply: (subject: string, offset: number) => unknown | Promise<unknown>) => {
  const calls: { subject: string; timeout: number }[] = [];
  let closed = 0;
  let connects = 0;
  const dependencies: NatsDiagnosticsDependencies = {
    connect: async (settings) => {
      expect(settings).toBe(config.application);
      connects++;
      return {
        request: async (subject, data, options) => {
          calls.push({ subject, timeout: options.timeout });
          const value = await reply(subject, JSON.parse(data).offset);
          return { json: () => value };
        },
        requestMany: async () => {
          throw new Error("System requests must not be used");
        },
        close: async () => {
          closed++;
        },
      };
    },
  };
  return {
    dependencies,
    calls,
    get closed() {
      return closed;
    },
    get connects() {
      return connects;
    },
  };
};

test("consumer metrics page all streams, aggregate real counters and omit note and consumer identity", async () => {
  const transport = fake((_subject, offset) => ({ total: 2, offset, consumers: [consumer(`consumer-${offset}`)] }));
  const samples = await getNatsConsumerMetricSamples(inventory("stream1", "stream2"), config, transport.dependencies);
  expect(samples.find((sample) => sample.name === "cloud_nats_consumers_pending")?.value).toBe(12);
  expect(samples.find((sample) => sample.name === "cloud_nats_consumers_ack_pending")?.value).toBe(8);
  expect(samples.find((sample) => sample.name === "cloud_nats_consumers_redelivered")?.value).toBe(4);
  expect(samples.find((sample) => sample.name === "cloud_sync_consumers_pending")).toMatchObject({
    value: 12,
    labels: { namespace: "test", owner: "notebooks", kind: "topic" },
  });
  expect(JSON.stringify(samples)).not.toContain("stream1");
  expect(JSON.stringify(samples)).not.toContain("consumer-0");
  expect(transport.calls).toHaveLength(4);
  expect(transport.closed).toBe(1);
});

test("consumer metric scans never exceed four concurrent requests", async () => {
  let active = 0;
  let peak = 0;
  const transport = fake(async () => {
    active++;
    peak = Math.max(peak, active);
    await Bun.sleep(2);
    active--;
    return { total: 0, offset: 0 };
  });
  const samples = await getNatsConsumerMetricSamples(
    inventory(...Array.from({ length: 12 }, (_, i) => `stream${i}`)),
    config,
    transport.dependencies,
  );
  expect(peak).toBe(4);
  expect(samples[0]?.value).toBe(1);
  expect(transport.calls.every((call) => call.timeout > 0 && call.timeout <= 1500)).toBe(true);
  expect(transport.closed).toBe(1);
});

test("partial stream inventories do not connect or publish misleading zero backlog", async () => {
  const transport = fake(() => ({}));
  const samples = await getNatsConsumerMetricSamples({ ...inventory("stream1"), status: "partial" }, config, transport.dependencies);
  expect(samples).toMatchObject([{ name: "cloud_nats_consumer_inventory_up", value: 0 }]);
  expect(transport.connects).toBe(0);
});

test("consumer pagination stops after the shared five-second deadline", async () => {
  let now = 10000;
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  const transport = fake(() => {
    now += 5001;
    return { total: 2, offset: 0, consumers: [consumer("first")] };
  });
  try {
    const samples = await getNatsConsumerMetricSamples(inventory("stream1"), config, transport.dependencies);
    expect(samples).toHaveLength(1);
    expect(samples[0]?.value).toBe(0);
    expect(transport.calls).toHaveLength(1);
    expect(transport.closed).toBe(1);
  } finally {
    clock.mockRestore();
  }
});

test("consumer errors, malformed counts, empty pages and pagination changes suppress every aggregate", async () => {
  for (const reply of [
    () => {
      throw new Error("request timed out");
    },
    () => ({ total: 1, offset: 0, consumers: [consumer("one"), consumer("two")] }),
    () => ({ total: 2, offset: 0, consumers: [] }),
    (_subject: string, offset: number) => ({ total: offset ? 3 : 2, offset, consumers: [consumer(`consumer-${offset}`)] }),
    (_subject: string, offset: number) => ({ total: 2, offset, consumers: [consumer("repeated")] }),
    () => ({ total: 1, offset: 0, consumers: [{ ...consumer("invalid"), num_pending: -1 }] }),
  ]) {
    const transport = fake(reply);
    const samples = await getNatsConsumerMetricSamples(inventory("stream1"), config, transport.dependencies);
    expect(samples).toHaveLength(1);
    expect(samples[0]?.value).toBe(0);
    expect(transport.closed).toBe(1);
  }
});
