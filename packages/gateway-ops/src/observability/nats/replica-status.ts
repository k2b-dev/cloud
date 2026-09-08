import type { NatsCluster, NatsNode } from "./service";

export const replicaStatus = (value: NatsCluster | null, expected: number | null) => {
  if (!value) return expected !== null && expected > 1 ? "unknown" : null;
  if (!value.leader) return "noLeader";
  if (value.replicas.some((peer) => peer.offline)) return "replicaOffline";
  if (expected !== null && value.replicas.length < expected - 1) return "replicaMissing";
  if (value.replicas.some((peer) => (peer.lag ?? 0) > 0)) return "replicaBehind";
  if (value.replicas.some((peer) => peer.current === false)) return "replicaNotCurrent";
  if (value.replicas.some((peer) => peer.current === null)) return "replicaUnknown";
  return "synchronized";
};

// Followers omit the metadata replica list. Only the elected leader owns it.
export const metadataSnapshot = (node: NatsNode, nodes: NatsNode[]) =>
  nodes.find(
    (candidate) =>
      candidate.jetstreamEnabled &&
      candidate.clusterName === node.clusterName &&
      candidate.name === node.meta?.leader &&
      candidate.meta?.leader === candidate.name,
  )?.meta ?? null;

export const nodeReplicaStatus = (node: NatsNode, nodes: NatsNode[]) => {
  if (!node.jetstreamEnabled) return "disabled";
  if (!node.meta) return "unknown";
  if (!node.meta.leader) return "noLeader";
  const metadata = metadataSnapshot(node, nodes);
  if (!metadata) return "unknown";
  const expected = node.expectedNodes ?? nodes.find((candidate) => candidate.meta === metadata)?.expectedNodes ?? null;
  return replicaStatus(metadata, expected) ?? "unknown";
};

export const replicaTone = (status: ReturnType<typeof nodeReplicaStatus>) => {
  if (status === "synchronized") return "ok";
  if (status === "noLeader" || status === "replicaOffline" || status === "replicaMissing") return "error";
  if (status === "disabled") return "neutral";
  return "warning";
};
