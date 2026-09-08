import { natsMetricSamples } from "./metrics";
import { expect, test } from "bun:test";
import { nodeReplicaStatus, replicaStatus, replicaTone } from "./replica-status";
import type { NatsNode, NatsReplica } from "./service";

const peer: NatsReplica = { name: "n2", current: true, offline: false, lag: 0 };
const state = (replicas: NatsReplica[], expected = 2, leader: string | null = "n1") =>
  replicaStatus({ name: "test", leader, replicas }, expected);

test("replica states distinguish known problems, unknown state and healthy replication", () => {
  expect(state([peer])).toBe("synchronized");
  expect(state([], 1)).toBe("synchronized");
  expect(state([peer], 2, null)).toBe("noLeader");
  expect(state([{ ...peer, offline: true, lag: 5 }])).toBe("replicaOffline");
  expect(state([])).toBe("replicaMissing");
  expect(state([{ ...peer, lag: 5, current: false }])).toBe("replicaBehind");
  expect(state([{ ...peer, current: false }])).toBe("replicaNotCurrent");
  expect(state([{ ...peer, current: null }])).toBe("replicaUnknown");
  expect(replicaStatus(null, 3)).toBe("unknown");
  expect(replicaStatus(null, 1)).toBeNull();
  expect(replicaStatus(null, null)).toBeNull();
});

const node = (name: string): NatsNode => ({
  id: name,
  name,
  version: "2.14",
  clusterName: "test",
  jetstreamEnabled: true,
  memory: 0,
  processMemory: 100,
  storage: 0,
  maxMemory: 100,
  maxStorage: 100,
  streams: 0,
  consumers: 0,
  expectedNodes: 3,
  meta: { name: "test", leader: "n1", replicas: name === "n1" ? [peer, { ...peer, name: "n3" }] : [] },
});

test("follower reports without replica lists use the elected leader snapshot", () => {
  const nodes = [node("n1"), node("n2"), node("n3")];
  expect(nodes.map((n) => nodeReplicaStatus(n, nodes))).toEqual(Array(3).fill("synchronized"));
  expect(nodeReplicaStatus(nodes[1]!, nodes.slice(1))).toBe("unknown");
  const foreignLeader = { ...nodes[0]!, clusterName: "other" };
  expect(nodeReplicaStatus(nodes[1]!, [foreignLeader, nodes[1]!])).toBe("unknown");
  const failedLeader = { ...nodes[0]!, meta: { name: "test", leader: "n1", replicas: [{ ...peer, offline: true }] } };
  expect(nodeReplicaStatus(nodes[1]!, [failedLeader, nodes[1]!])).toBe("replicaOffline");
});

test("status colors retain text and distinguish healthy, uncertain and failed states", () => {
  expect(replicaTone("synchronized")).toBe("ok");
  for (const status of ["unknown", "replicaBehind", "replicaNotCurrent", "replicaUnknown"] as const)
    expect(replicaTone(status)).toBe("warning");
  for (const status of ["replicaOffline", "replicaMissing", "noLeader"] as const) expect(replicaTone(status)).toBe("error");
  expect(replicaTone("disabled")).toBe("neutral");
});

test("metadata metrics preserve no-leader failures and signal unavailable leader snapshots", () => {
  const inventory = { status: "not_configured" as const, streams: [], total: null, sampledAt: "" };
  const samples = (nodes: NatsNode[]) => natsMetricSamples({ status: "available", nodes }, inventory);
  const healthy = samples([node("n1"), node("n2"), node("n3")]);
  expect(healthy.filter((m) => m.name === "cloud_nats_meta_replicas_unhealthy").map((m) => m.value)).toEqual([0, 0, 0]);
  const noLeader = samples([{ ...node("n1"), meta: { name: "test", leader: null, replicas: [] } }]);
  expect(noLeader.find((m) => m.name === "cloud_nats_meta_replicas_unhealthy")?.value).toBe(1);
  const missingLeader = samples([node("n2"), node("n3")]);
  expect(missingLeader.find((m) => m.name === "cloud_nats_cluster_up")?.value).toBe(0);
  expect(missingLeader.some((m) => m.name === "cloud_nats_meta_replicas_unhealthy")).toBe(false);
});
