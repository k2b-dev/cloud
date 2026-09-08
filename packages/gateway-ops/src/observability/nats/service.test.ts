import { describe, expect, test } from "bun:test";
import {
  getNatsClusterDiagnostics,
  getNatsDiagnostics,
  getNatsInventorySummary,
  type NatsDiagnosticsConfig,
  type NatsDiagnosticsDependencies,
} from "./service";
const config: NatsDiagnosticsConfig = { admin: { servers: ["nats://system"] }, application: { servers: ["nats://account"] } };
const empty: NatsDiagnosticsConfig = { admin: { servers: [] }, application: { servers: [] } };
const resource = (name = "S6_QD_test") => ({
  config: {
    name,
    storage: "file",
    num_replicas: 3,
    max_bytes: -1,
    max_msgs: -1,
    max_age: 1_000_000_000,
    metadata: { "sync.namespace": "test", "sync.owner": "mail", "sync.kind": "queue", "sync.id": "work", secret: "never expose" },
  },
  state: { messages: 4, bytes: 20, consumer_count: 1 },
  cluster: { leader: "node-1", replicas: [{ name: "node-2", current: false, lag: 3 }] },
});
const node = (name = "node-1", size = 1) => ({
  server: { id: name, name, ver: "2.14.0", cluster: "test" },
  data: {
    memory: 0,
    storage: 20,
    streams: 1,
    consumers: 1,
    config: { max_memory: 100, max_storage: 1000 },
    meta_cluster: { name: "test", leader: "node-1", cluster_size: size },
  },
});
const fake = (
  pages: unknown[] = [],
  nodes: unknown[] = [node()],
  processes: unknown[] = [{ server: { id: "node-1" }, data: { mem: 123456 } }],
) => {
  const requests: { role: string; subject: string; data: string }[] = [];
  const closed: string[] = [];
  let index = 0;
  const dependencies: NatsDiagnosticsDependencies = {
    connect: async (_config, role) => ({
      request: async (subject, data) => {
        requests.push({ role, subject, data });
        const value = pages[index++];
        if (value instanceof Error) throw value;
        return { json: () => value };
      },
      requestMany: async (subject, data) => {
        requests.push({ role, subject, data });
        return (async function* () {
          for (const value of subject.endsWith(".VARZ") ? processes : nodes) {
            if (value instanceof Error) throw value;
            yield { json: () => value };
          }
        })();
      },
      close: async () => {
        closed.push(role);
      },
    }),
  };
  return { dependencies, requests, closed };
};
describe("read-only NATS diagnostics", () => {
  test("unconfigured does no network I/O and never invents empty account totals", async () => {
    const f = fake();
    const result = await getNatsDiagnostics({}, empty, f.dependencies);
    expect(result.cluster.status).toBe("not_configured");
    expect(result.inventory.status).toBe("not_configured");
    expect(result.inventory.total).toBeNull();
    expect(f.requests).toEqual([]);
  });
  test("separates system and application accounts, sanitizes config, closes both connections", async () => {
    const f = fake([{ total: 2, offset: 0, limit: 1, streams: [resource()] }]);
    const result = await getNatsDiagnostics({}, config, f.dependencies);
    expect(result.cluster.status).toBe("available");
    expect(result.inventory).toMatchObject({ status: "available", total: 2, nextOffset: 1 });
    expect(result.inventory.streams[0]).toMatchObject({
      deadLetter: true,
      maxAgeMs: 1000,
      sync: { namespace: "test", owner: "mail", id: "work" },
    });
    expect(JSON.stringify(result)).not.toContain("never expose");
    expect(f.requests).toContainEqual({ role: "system", subject: "$SYS.REQ.SERVER.PING.JSZ", data: "{}" });
    expect(f.requests).toContainEqual({ role: "account", subject: "$JS.API.STREAM.LIST", data: '{"offset":0}' });
    expect(f.closed.sort()).toEqual(["account", "system"]);
  });
  test("process RAM is matched by server ID, independently of JetStream memory storage", async () => {
    const f = fake(
      [],
      [node("node-1", 2), node("node-2", 2)],
      [
        { server: { id: "node-2" }, data: { mem: 222 } },
        { server: { id: "node-1" }, data: { mem: 111 } },
      ],
    );
    const result = await getNatsClusterDiagnostics(config, f.dependencies);
    expect(result.status).toBe("available");
    expect(result.nodes.map(({ memory, processMemory }) => ({ memory, processMemory }))).toEqual([
      { memory: 0, processMemory: 111 },
      { memory: 0, processMemory: 222 },
    ]);
  });
  test("missing or invalid process RAM stays unknown and preserves JetStream diagnostics", async () => {
    for (const processes of [[], [{ server: { id: "node-1" }, data: { mem: -1 } }], [new Error("denied secret")]]) {
      const result = await getNatsClusterDiagnostics(config, fake([], [node()], processes).dependencies);
      expect(result.status).toBe("partial");
      expect(result.nodes[0]).toMatchObject({ processMemory: null, memory: 0, storage: 20 });
      expect(JSON.stringify(result)).not.toContain("secret");
    }
  });
  test("account denial is unavailable, not empty and does not leak server error text", async () => {
    const f = fake([new Error("token secret at nats://user:pass@host")]);
    const result = await getNatsDiagnostics({}, config, f.dependencies);
    expect(result.inventory.status).toBe("unavailable");
    expect(result.inventory.total).toBeNull();
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(f.closed).toContain("account");
  });
  test("consumer denial preserves stream page and marks partial", async () => {
    const f = fake([{ total: 1, offset: 0, limit: 256, streams: [resource()] }, { error: { code: 403 } }]);
    const result = await getNatsDiagnostics({ consumerStream: "S6_QD_test" }, config, f.dependencies);
    expect(result.inventory.status).toBe("partial");
    expect(result.inventory.streams).toHaveLength(1);
    expect(result.inventory.consumerTotal).toBeNull();
  });
  test("consumer page exposes pending, ack pending and replica lag without message data", async () => {
    const f = fake([
      { total: 0, offset: 0, limit: 256 },
      {
        total: 2,
        offset: 1,
        limit: 1,
        consumers: [{ name: "worker", num_pending: 10, num_ack_pending: 2, num_redelivered: 1, config: { filter_subject: "secret" } }],
      },
    ]);
    const result = await getNatsDiagnostics({ consumerStream: "legal-stream", consumerOffset: 1 }, config, f.dependencies);
    expect(result.inventory.consumers).toEqual([{ name: "worker", pending: 10, ackPending: 2, redelivered: 1, cluster: null }]);
    expect(result.inventory.consumerNextOffset).toBeNull();
    expect(JSON.stringify(result)).not.toContain("secret");
  });
  test("invalid selectors never reach broker subjects", async () => {
    const f = fake();
    for (const consumerStream of ["*", "x.>", "x y", "x/y"])
      await expect(getNatsDiagnostics({ consumerStream }, config, f.dependencies)).rejects.toThrow("Invalid NATS stream name");
    await expect(getNatsDiagnostics({ streamOffset: -1 }, config, f.dependencies)).rejects.toThrow("Invalid NATS inventory offset");
    expect(f.requests).toHaveLength(0);
  });
  test("missing expected cluster node is partial, duplicate reports count once", async () => {
    const f = fake([], [node("node-1", 3), node("node-1", 3), node("node-2", 3)]);
    const result = await getNatsClusterDiagnostics(config, f.dependencies);
    expect(result.status).toBe("partial");
    expect(result.nodes).toHaveLength(2);
  });
  test("no system replies is unavailable and absent node stats stay unknown", async () => {
    expect((await getNatsClusterDiagnostics(config, fake([], []).dependencies)).status).toBe("unavailable");
    const minimal = { server: node().server, data: { disabled: true } };
    const result = await getNatsClusterDiagnostics(config, fake([], [minimal]).dependencies);
    expect(result.nodes[0]).toMatchObject({ jetstreamEnabled: false, memory: null, storage: null, expectedNodes: null });
  });
  test("complete summary follows pages and has no replica double counting", async () => {
    const f = fake([
      { total: 2, offset: 0, limit: 1, streams: [resource()] },
      { total: 2, offset: 1, limit: 1, streams: [resource("KV_bucket")] },
    ]);
    const result = await getNatsInventorySummary(config, f.dependencies);
    expect(result.status).toBe("available");
    expect(result.streams).toHaveLength(2);
    expect(result.streams[1]).toMatchObject({ kind: "kv", deadLetter: false });
    expect(f.closed).toEqual(["account-summary"]);
  });
  test("changing inventory total cannot be reported complete", async () => {
    const f = fake([
      { total: 2, offset: 0, limit: 1, streams: [resource()] },
      { total: 3, offset: 1, limit: 1, streams: [resource("other")] },
    ]);
    expect((await getNatsInventorySummary(config, f.dependencies)).status).toBe("partial");
  });
  test("page-budget exhaustion is explicit partial and bounds broker requests", async () => {
    const f = fake(
      Array.from({ length: 16 }, (_, index) => ({ total: 100, offset: index, limit: 1, streams: [resource(`stream-${index}`)] })),
    );
    const result = await getNatsInventorySummary(config, f.dependencies);
    expect(result.status).toBe("partial");
    expect(f.requests).toHaveLength(16);
  });
  test("duplicate or empty pages cannot masquerade as complete inventory", async () => {
    const f = fake([
      { total: 2, offset: 0, limit: 1, streams: [resource()] },
      { total: 2, offset: 1, limit: 1, streams: [resource()] },
    ]);
    expect((await getNatsInventorySummary(config, f.dependencies)).status).toBe("partial");
    expect((await getNatsInventorySummary(config, fake([{ total: 2, offset: 0, limit: 256 }]).dependencies)).status).toBe("partial");
  });
});
