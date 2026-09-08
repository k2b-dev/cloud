import { metadataSnapshot } from "./replica-status";
import type { NatsDiagnostics, NatsInventorySummary } from "./service";

type Sample = { name: string; help: string; type: "gauge"; value: number; labels?: Record<string, string> };
const sample = (name: string, help: string, value: number, labels?: Record<string, string>): Sample => ({
  name,
  help,
  type: "gauge",
  value,
  labels,
});

/** No per-note labels or replica summation. Incomplete inventory never produces fleet totals. */
export const natsMetricSamples = (cluster: NatsDiagnostics["cluster"], inventory: NatsInventorySummary): Sample[] => {
  const samples = [
    sample(
      "cloud_nats_cluster_configured",
      "Whether a dedicated system diagnostic connection is configured.",
      cluster.status === "not_configured" ? 0 : 1,
    ),
    sample(
      "cloud_nats_cluster_up",
      "Whether the configured cluster snapshot is complete.",
      cluster.status === "available" &&
        cluster.nodes.every((node) => !node.jetstreamEnabled || (node.meta && (!node.meta.leader || metadataSnapshot(node, cluster.nodes))))
        ? 1
        : 0,
    ),
    sample("cloud_nats_inventory_up", "Whether the application account inventory is complete.", inventory.status === "available" ? 1 : 0),
  ];
  for (const node of cluster.nodes) {
    const labels = { node: node.name, cluster: node.clusterName ?? "" };
    samples.push(sample("cloud_nats_jetstream_enabled", "Whether this node has JetStream enabled.", node.jetstreamEnabled ? 1 : 0, labels));
    for (const [name, value, help] of [
      ["cloud_nats_node_storage_bytes", node.storage, "Physical JetStream bytes on the node, including replicas and all accounts."],
      ["cloud_nats_node_storage_limit_bytes", node.maxStorage, "Configured JetStream file storage limit for the node."],
      ["cloud_nats_node_memory_bytes", node.memory, "JetStream memory bytes on the node."],
      ["cloud_nats_node_memory_limit_bytes", node.maxMemory, "Configured JetStream memory limit for the node."],
    ] as const)
      if (value !== null) samples.push(sample(name, help, value, labels));
    const metadata = metadataSnapshot(node, cluster.nodes);
    if (node.jetstreamEnabled && node.meta && !node.meta.leader)
      samples.push(sample("cloud_nats_meta_replicas_unhealthy", "Metadata replicas offline, missing or not current.", 1, labels));
    else if (metadata)
      samples.push(
        sample(
          "cloud_nats_meta_replicas_unhealthy",
          "Metadata replicas offline, missing or not current.",
          metadata.replicas.filter((peer) => peer.offline || peer.current !== true || (peer.lag ?? 0) > 0).length +
            Math.max(0, (node.expectedNodes ?? 1) - 1 - metadata.replicas.length) +
            (metadata.leader ? 0 : 1),
          labels,
        ),
      );
  }
  if (inventory.status !== "available") return samples;
  const streams = [...new Map(inventory.streams.map((stream) => [stream.name, stream])).values()];
  samples.push(sample("cloud_nats_account_streams", "Logical streams in the connected application account.", streams.length));
  samples.push(
    sample(
      "cloud_nats_account_storage_bytes",
      "Logical bytes in the connected application account, counted once per stream.",
      streams.reduce((sum, stream) => sum + stream.bytes, 0),
    ),
  );
  const groups = new Map<
    string,
    {
      labels: Record<string, string>;
      streams: number;
      bytes: number;
      messages: number;
      consumers: number;
      deadLetters: number;
      unhealthy: number;
    }
  >();
  for (const stream of streams) {
    if (!stream.sync) continue;
    const labels = { namespace: stream.sync.namespace, owner: stream.sync.owner, kind: stream.sync.kind };
    const key = JSON.stringify(labels);
    const group = groups.get(key) ?? { labels, streams: 0, bytes: 0, messages: 0, consumers: 0, deadLetters: 0, unhealthy: 0 };
    group.streams++;
    group.bytes += stream.bytes;
    group.messages += stream.messages;
    group.consumers += stream.consumers;
    if (stream.deadLetter) group.deadLetters += stream.messages;
    if (
      stream.replicas > 1 &&
      (!stream.cluster?.leader ||
        stream.cluster.replicas.length < stream.replicas - 1 ||
        stream.cluster.replicas.some((peer) => peer.offline || peer.current !== true || (peer.lag ?? 0) > 0))
    )
      group.unhealthy++;
    groups.set(key, group);
  }
  for (const group of groups.values())
    for (const [name, value, help] of [
      ["cloud_sync_streams", group.streams, "Sync backing streams by namespace, owner and kind."],
      ["cloud_sync_storage_bytes", group.bytes, "Logical Sync stream bytes, excluding replica duplication."],
      ["cloud_sync_messages", group.messages, "Retained messages in Sync backing streams."],
      ["cloud_sync_consumers", group.consumers, "Consumers on Sync backing streams."],
      ["cloud_sync_dead_letters", group.deadLetters, "Retained dead letters in Sync transport streams."],
      ["cloud_sync_streams_replication_unhealthy", group.unhealthy, "Sync streams with unavailable or lagging replication."],
    ] as const)
      samples.push(sample(name, help, value, group.labels));
  return samples;
};
