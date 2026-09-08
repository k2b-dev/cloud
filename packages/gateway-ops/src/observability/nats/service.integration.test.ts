import { expect, test } from "bun:test";
import { connect } from "@nats-io/transport-node";
import { getNatsClusterDiagnostics, getNatsDiagnostics, getNatsInventorySummary, natsDiagnosticsConfig } from "./service";

const systemIntegration = process.env.NATS_DIAGNOSTICS_TEST === "1" && process.env.NATS_ADMIN_SERVERS ? test : test.skip;
systemIntegration(
  "dedicated system identity sees the cluster while the application identity cannot",
  async () => {
    const config = natsDiagnosticsConfig();
    const cluster = await getNatsClusterDiagnostics(config);
    expect(cluster.status).toBe("available");
    expect(cluster.nodes.length).toBeGreaterThanOrEqual(3);
    expect(cluster.nodes.every((node) => node.jetstreamEnabled && node.meta?.leader)).toBe(true);
    const unprivileged = await getNatsClusterDiagnostics({ ...config, admin: config.application });
    expect(unprivileged.status).toBe("unavailable");
    expect(unprivileged.nodes).toEqual([]);
  },
  10_000,
);

const integration = process.env.NATS_DIAGNOSTICS_TEST === "1" ? test : test.skip;
integration(
  "real account inventory exposes only metadata and consumer counters, preserving existing streams",
  async () => {
    const servers = (process.env.SYNC_TEST_SERVERS ?? "nats://localhost:4222").split(",");
    const namespace = `nats-diagnostics-${crypto.randomUUID()}`;
    const name = `S6_QD_${crypto.randomUUID().replaceAll("-", "")}`;
    const subject = `${namespace}.work`;
    const connection = await connect({ servers, timeout: 1500, reconnect: false });
    const config = { admin: { servers: [] }, application: { servers } };
    let created = false;
    try {
      const create = await connection.request(
        `$JS.API.STREAM.CREATE.${name}`,
        JSON.stringify({
          name,
          subjects: [subject],
          storage: "file",
          num_replicas: 3,
          metadata: { "sync.namespace": namespace, "sync.owner": "diagnostics-test", "sync.kind": "queue", "sync.id": "work" },
        }),
      );
      expect(create.json<{ error?: unknown }>().error).toBeUndefined();
      created = true;
      const consumer = await connection.request(
        `$JS.API.CONSUMER.DURABLE.CREATE.${name}.fixture`,
        JSON.stringify({
          stream_name: name,
          config: { durable_name: "fixture", ack_policy: "explicit", deliver_policy: "all" },
        }),
      );
      expect(consumer.json<{ error?: unknown }>().error).toBeUndefined();
      await connection.request(subject, JSON.stringify({ sensitive: "never returned by diagnostics" }));
      const summary = await getNatsInventorySummary(config);
      expect(summary.status).toBe("available");
      expect(summary.streams.find((stream) => stream.name === name)).toMatchObject({
        messages: 1,
        consumers: 1,
        replicas: 3,
        deadLetter: true,
        sync: { namespace, owner: "diagnostics-test" },
      });
      const result = await getNatsDiagnostics({ consumerStream: name }, config);
      expect(result.inventory.status).toBe("available");
      expect(result.inventory.consumers).toMatchObject([{ name: "fixture", pending: 1, ackPending: 0 }]);
      expect(JSON.stringify(result)).not.toContain("never returned by diagnostics");
    } finally {
      if (created) {
        const deleted = await connection.request(`$JS.API.STREAM.DELETE.${name}`);
        expect(deleted.json<{ success: boolean }>().success).toBe(true);
      }
      await connection.close();
    }
  },
  15_000,
);
