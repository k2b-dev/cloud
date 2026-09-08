import { z } from "zod";
import { nodeReplicaStatus, replicaStatus } from "./replica-status";
import {
  getNatsClusterDiagnostics,
  getNatsDiagnostics,
  getNatsInventorySummary,
  type NatsDiagnostics,
  type NatsInventorySummary,
  type NatsStream,
  natsDiagnosticsConfig,
  natsDiagnosticsDependencies,
} from "./service";

export const NatsQuerySchema = z.object({
  app: z.string().trim().max(200).optional(),
  namespace: z.string().trim().max(200).optional(),
  resource: z.string().trim().max(256).optional(),
  problems: z.enum(["true", "false"]).optional(),
  offset: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  stream: z
    .string()
    .regex(/^[A-Za-z0-9_-]+$/)
    .max(256)
    .optional(),
  consumerOffset: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
});
export type NatsQuery = z.infer<typeof NatsQuerySchema>;

export const streamHasReplicationProblem = (stream: NatsStream) => {
  const status = replicaStatus(stream.cluster, stream.replicas);
  return status !== null && status !== "synchronized";
};
export const streamHasProblem = (stream: NatsStream) => (stream.deadLetter && stream.messages > 0) || streamHasReplicationProblem(stream);

/** Filtering applies to the bounded account scan, never just a broker page. */
export const selectNatsStreams = (snapshot: NatsInventorySummary, query: NatsQuery) => {
  const resource = query.resource?.toLocaleLowerCase("en");
  const scoped = snapshot.streams.filter(
    (stream) =>
      (!query.app || stream.sync?.owner === query.app) &&
      (!query.namespace || stream.sync?.namespace === query.namespace) &&
      (!resource || stream.name.toLocaleLowerCase("en").includes(resource) || stream.sync?.id.toLocaleLowerCase("en").includes(resource)),
  );
  const matching = scoped.filter((stream) => query.problems !== "true" || streamHasProblem(stream));
  matching.sort((a, b) => Number(streamHasProblem(b)) - Number(streamHasProblem(a)) || a.name.localeCompare(b.name));
  return {
    streams: matching.slice(query.offset, query.offset + query.limit).map((stream) => ({
      ...stream,
      replicationStatus: replicaStatus(stream.cluster, stream.replicas),
      hasDeadLetters: stream.deadLetter && stream.messages > 0,
    })),
    total: matching.length,
    matchedTotal: snapshot.status === "available" ? matching.length : null,
    accountTotal: snapshot.total,
    scannedTotal: snapshot.streams.length,
    offset: query.offset,
    limit: query.limit,
    nextOffset: query.offset + query.limit < matching.length ? query.offset + query.limit : null,
    filters: {
      app: query.app ?? null,
      namespace: query.namespace ?? null,
      resource: query.resource ?? null,
      problems: query.problems === "true",
    },
    summary: {
      problemStreams: scoped.filter(streamHasProblem).length,
      deadLetterStreams: scoped.filter((stream) => stream.deadLetter && stream.messages > 0).length,
      replicationProblems: scoped.filter(streamHasReplicationProblem).length,
    },
  };
};

export const readNatsDiagnostics = async (
  query: NatsQuery,
  config = natsDiagnosticsConfig(),
  dependencies = natsDiagnosticsDependencies,
) => {
  const [cluster, snapshot] = await Promise.all([
    getNatsClusterDiagnostics(config, dependencies),
    getNatsInventorySummary(config, dependencies),
  ]);
  let consumerData: Pick<
    NatsDiagnostics["inventory"],
    "consumers" | "consumerTotal" | "consumerStream" | "consumerOffset" | "consumerNextOffset"
  > = {
    consumers: [],
    consumerTotal: null,
    consumerStream: query.stream ?? null,
    consumerOffset: query.consumerOffset,
    consumerNextOffset: null,
  };
  let status = snapshot.status;
  let issue = snapshot.issue;
  if (query.stream) {
    // Reuse the account-only consumer reader; the shared snapshot owns stream totals.
    const result = await getNatsDiagnostics(
      { consumerStream: query.stream, consumerOffset: query.consumerOffset },
      { ...config, admin: { servers: [] } },
      dependencies,
    );
    const inventory = result.inventory;
    consumerData = {
      consumers: inventory.consumers,
      consumerTotal: inventory.consumerTotal,
      consumerStream: inventory.consumerStream,
      consumerOffset: inventory.consumerOffset,
      consumerNextOffset: inventory.consumerNextOffset,
    };
    if (inventory.status !== "available" && status === "available") {
      status = "partial";
      issue = inventory.issue;
    }
  }
  return {
    sampledAt: new Date().toISOString(),
    cluster: { ...cluster, nodes: cluster.nodes.map((node) => ({ ...node, metadataStatus: nodeReplicaStatus(node, cluster.nodes) })) },
    inventory: { ...selectNatsStreams(snapshot, query), ...consumerData, status, ...(issue ? { issue } : {}) },
  };
};
