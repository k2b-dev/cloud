/** Read-only NATS operations; machine output retains snapshot completeness. */
import { arg, type CloudCliContext, command, flag } from "../index";
import { apiGet, formatBytes, queryString } from "./shared";

type Replica = { name: string; current: boolean | null; offline: boolean | null; lag: number | null };
type Cluster = { name: string | null; leader: string | null; replicas: Replica[] };
type Node = {
  id: string;
  name: string;
  version: string;
  jetstreamEnabled: boolean;
  metadataStatus: string;
  processMemory: number | null;
  storage: number | null;
  meta: Cluster | null;
};
type Stream = {
  name: string;
  kind: string;
  storage: string;
  messages: number;
  bytes: number;
  consumers: number;
  replicas: number;
  deadLetter: boolean;
  replicationStatus: string | null;
  hasDeadLetters: boolean;
  cluster: Cluster | null;
  sync: { namespace: string; owner: string; kind: string; id: string } | null;
};
type Consumer = { name: string; pending: number; ackPending: number; redelivered: number; cluster: Cluster | null };
export type NatsSnapshot = {
  sampledAt: string;
  cluster: { status: string; issue?: string; nodes: Node[] };
  inventory: {
    status: string;
    issue?: string;
    streams: Stream[];
    total: number;
    matchedTotal: number | null;
    scannedTotal: number;
    accountTotal: number | null;
    offset: number;
    limit: number;
    nextOffset: number | null;
    consumers: Consumer[];
    consumerTotal: number | null;
    consumerStream: string | null;
    consumerOffset: number;
    consumerNextOffset: number | null;
  };
};
const read = (ctx: CloudCliContext, params: Parameters<typeof queryString>[0] = {}) =>
  apiGet<NatsSnapshot>(ctx, `/api/gateway/nats${queryString(params)}`);
const machine = (ctx: CloudCliContext, result: NatsSnapshot, section: "nodes" | "streams" | "consumers") => {
  if (ctx.options.output === "json") {
    ctx.json(result);
    return true;
  }
  if (ctx.options.output === "jsonl") {
    const { nodes: _nodes, ...cluster } = result.cluster;
    const { streams: _streams, consumers: _consumers, ...inventory } = result.inventory;
    ctx.jsonLine({ type: "snapshot", sampledAt: result.sampledAt, cluster, inventory });
    for (const item of section === "nodes" ? result.cluster.nodes : result.inventory[section]) ctx.jsonLine({ type: section, ...item });
    return true;
  }
  ctx.print(`Snapshot: ${result.sampledAt}; cluster: ${result.cluster.status}; inventory: ${result.inventory.status}`);
  if (result.cluster.issue) ctx.error(result.cluster.issue);
  if (result.inventory.issue) ctx.error(result.inventory.issue);
  return false;
};
export const natsCommands = [
  command("nats status", {
    summary: "Inspect NATS nodes and account inventory completeness",
    run: async ({ ctx }) => {
      const result = await read(ctx);
      if (machine(ctx, result, "nodes")) return;
      ctx.table(
        result.cluster.nodes.map((node) => ({
          name: node.name,
          version: node.version,
          jetstream: node.jetstreamEnabled ? "enabled" : "disabled",
          metadataStatus: node.metadataStatus,
          metadataLeader: node.meta?.leader ?? "unknown",
          memory: formatBytes(node.processMemory),
          storage: formatBytes(node.storage),
        })),
        [
          { key: "name" },
          { key: "version" },
          { key: "jetstream" },
          { key: "metadataStatus" },
          { key: "metadataLeader" },
          { key: "memory" },
          { key: "storage" },
        ],
      );
    },
  }),
  command("nats streams list", {
    summary: "Find NATS streams and buckets; filters apply before pagination",
    flags: {
      app: flag.string({ description: "Exact Sync owner" }),
      namespace: flag.string({ description: "Exact Sync namespace" }),
      resource: flag.string({ description: "Search stream name or Sync resource ID" }),
      problems: flag.boolean({ description: "Only dead-letter or replication problems" }),
      offset: flag.int({ min: 0, default: 0, description: "Filtered result offset" }),
      limit: flag.int({ min: 1, max: 100, default: 50, description: "Rows per page" }),
    },
    run: async ({ ctx, flags }) => {
      const result = await read(ctx, flags);
      if (machine(ctx, result, "streams")) return;
      ctx.table(
        result.inventory.streams.map((stream) => ({
          name: stream.name,
          kind: stream.kind,
          namespace: stream.sync?.namespace ?? "-",
          app: stream.sync?.owner ?? "-",
          resource: stream.sync?.id ?? "-",
          messages: stream.messages,
          storage: formatBytes(stream.bytes),
          replicas: stream.replicas,
          replication: stream.replicationStatus ?? "-",
          deadLetters: stream.hasDeadLetters ? "yes" : "no",
          consumers: stream.consumers,
        })),
        [
          { key: "name" },
          { key: "kind" },
          { key: "namespace" },
          { key: "app" },
          { key: "resource" },
          { key: "messages" },
          { key: "storage" },
          { key: "replicas" },
          { key: "replication" },
          { key: "deadLetters" },
          { key: "consumers" },
        ],
      );
      ctx.print(
        `Matches: ${result.inventory.matchedTotal ?? `${result.inventory.total}+ (incomplete)`}; next offset: ${result.inventory.nextOffset ?? "none"}`,
      );
    },
  }),
  command("nats consumers list", {
    summary: "Inspect consumers and delivery backlog for one NATS stream",
    args: { stream: arg.required({ valueLabel: "stream" }) },
    flags: { offset: flag.int({ min: 0, default: 0, description: "Consumer result offset" }) },
    run: async ({ ctx, args, flags }) => {
      if (!/^[A-Za-z0-9_-]+$/.test(args.stream)) throw new Error("Invalid NATS stream name.");
      const result = await read(ctx, { stream: args.stream, consumerOffset: flags.offset });
      if (machine(ctx, result, "consumers")) return;
      ctx.table(
        result.inventory.consumers.map((consumer) => ({
          name: consumer.name,
          pending: consumer.pending,
          ackPending: consumer.ackPending,
          redelivered: consumer.redelivered,
          leader: consumer.cluster?.leader ?? "-",
        })),
        [{ key: "name" }, { key: "pending" }, { key: "ackPending" }, { key: "redelivered" }, { key: "leader" }],
      );
      ctx.print(`Consumers: ${result.inventory.consumerTotal ?? "unknown"}; next offset: ${result.inventory.consumerNextOffset ?? "none"}`);
    },
  }),
];
