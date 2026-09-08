import { z } from "zod";
import { natsDiagnosticsConfig, natsDiagnosticsDependencies, type NatsDiagnosticsDependencies, type NatsInventorySummary } from "./service";

const counter = z.number().int().nonnegative();
const pageSchema = z.object({
  total: counter,
  offset: counter,
  consumers: z.array(z.object({ name: z.string(), num_pending: counter, num_ack_pending: counter, num_redelivered: counter })).default([]),
});
type Totals = { pending: number; ackPending: number; redelivered: number };
type Sample = { name: string; help: string; type: "gauge"; value: number; labels?: Record<string, string> };
const emptyTotals = (): Totals => ({ pending: 0, ackPending: 0, redelivered: 0 });

/** Four concurrent read-only scans share one five-second request budget. */
export async function getNatsConsumerMetricSamples(
  inventory: NatsInventorySummary,
  config = natsDiagnosticsConfig(),
  dependencies: NatsDiagnosticsDependencies = natsDiagnosticsDependencies,
): Promise<Sample[]> {
  const up: Sample = {
    name: "cloud_nats_consumer_inventory_up",
    help: "Whether every stream consumer inventory was read completely within the scrape budget.",
    type: "gauge",
    value: 0,
  };
  if (inventory.status !== "available" || !config.application.servers.length) return [up];
  const streams = [...new Map(inventory.streams.map((stream) => [stream.name, stream])).values()];
  const deadline = Date.now() + 5_000;
  const totals = emptyTotals();
  const groups = new Map<string, { labels: Record<string, string>; totals: Totals }>();
  let connection: Awaited<ReturnType<NatsDiagnosticsDependencies["connect"]>> | undefined;
  let nextStream = 0;
  let complete = true;
  try {
    connection = await dependencies.connect(config.application, "consumer-metrics");
    const client = connection;
    const scan = async () => {
      while (complete && nextStream < streams.length) {
        const stream = streams[nextStream++]!;
        if (!/^[A-Za-z0-9_-]+$/.test(stream.name)) throw new Error("Invalid stream subject");
        const seen = new Set<string>();
        const streamTotals = emptyTotals();
        let offset = 0;
        let total: number | undefined;
        for (;;) {
          const remaining = deadline - Date.now();
          if (remaining <= 0) throw new Error("Consumer scan budget exceeded");
          const reply = await client.request(`$JS.API.CONSUMER.LIST.${stream.name}`, JSON.stringify({ offset }), {
            timeout: Math.min(1_500, remaining),
          });
          const page = pageSchema.parse(reply.json());
          if (page.offset !== offset || (total !== undefined && total !== page.total)) throw new Error("Consumer pagination changed");
          total = page.total;
          for (const consumer of page.consumers) {
            if (seen.has(consumer.name)) throw new Error("Consumer pagination repeated an entry");
            seen.add(consumer.name);
            streamTotals.pending += consumer.num_pending;
            streamTotals.ackPending += consumer.num_ack_pending;
            streamTotals.redelivered += consumer.num_redelivered;
          }
          offset += page.consumers.length;
          if (offset === total) break;
          if (!page.consumers.length || offset > total) throw new Error("Consumer pagination incomplete");
        }
        for (const key of ["pending", "ackPending", "redelivered"] as const) totals[key] += streamTotals[key];
        if (stream.sync) {
          const labels = { namespace: stream.sync.namespace, owner: stream.sync.owner, kind: stream.sync.kind };
          const key = JSON.stringify(labels);
          const group = groups.get(key) ?? { labels, totals: emptyTotals() };
          for (const field of ["pending", "ackPending", "redelivered"] as const) group.totals[field] += streamTotals[field];
          groups.set(key, group);
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(4, streams.length) }, () =>
        scan().catch(() => {
          complete = false;
        }),
      ),
    );
    if (!complete || Date.now() > deadline) return [up];
    up.value = 1;
    const samples = [up];
    const append = (prefix: string, values: Totals, labels?: Record<string, string>) => {
      for (const [suffix, value, help] of [
        ["pending", values.pending, "Messages awaiting delivery across consumers; independent consumers count independently."],
        ["ack_pending", values.ackPending, "Delivered messages awaiting acknowledgement across consumers."],
        ["redelivered", values.redelivered, "Messages currently marked redelivered across consumers."],
      ] as const)
        samples.push({ name: `${prefix}_${suffix}`, help, type: "gauge", value, labels });
    };
    append("cloud_nats_consumers", totals);
    for (const group of groups.values()) append("cloud_sync_consumers", group.totals, group.labels);
    return samples;
  } catch {
    return [up];
  } finally {
    await connection?.close();
  }
}
