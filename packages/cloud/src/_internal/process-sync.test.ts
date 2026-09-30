import { afterEach, expect, spyOn, test } from "bun:test";
import { createServer, type Socket, connect as tcpConnect } from "node:net";
import * as syncModule from "@k2b/sync";
import { natsServers, natsSuite, testSyncNamespace } from "../../../../scripts/fixtures/test-infra";
import { env } from "../config/env";
import * as nats from "./nats-connection";
import { getProcessSync, lazySync, startProcessSync, waitForNats } from "./process-sync";

const suite = natsSuite();
const originalNamespace = process.env.SYNC_NAMESPACE;
afterEach(() => {
  if (originalNamespace === undefined) delete process.env.SYNC_NAMESPACE;
  else process.env.SYNC_NAMESPACE = originalNamespace;
});
const isolate = () => {
  process.env.SYNC_NAMESPACE = testSyncNamespace("process");
};

/**
 * A loopback port that refuses connections until `open()`, then forwards each
 * connection to the test NATS server: NATS that becomes reachable only after
 * the process started, as after a restart of the whole stack.
 */
const delayedNats = async () => {
  const upstream = new URL(natsServers()[0]!);
  const sockets = new Set<Socket>();
  const server = createServer((client) => {
    const broker = tcpConnect(Number(upstream.port || 4222), upstream.hostname);
    for (const socket of [client, broker]) {
      sockets.add(socket);
      socket.on("error", () => {
        client.destroy();
        broker.destroy();
      });
      socket.on("close", () => sockets.delete(socket));
    }
    client.pipe(broker).pipe(client);
  });
  // Reserve a free port, then leave it closed until open().
  const port = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(typeof address === "object" && address ? address.port : 0));
    });
  });
  return {
    url: `nats://127.0.0.1:${port}`,
    open: () => server.listen(port, "127.0.0.1"),
    close: async () => {
      for (const socket of sockets) socket.destroy();
      if (server.listening) await new Promise((resolve) => server.close(resolve));
    },
  };
};

suite("process Sync lifecycle", () => {
  test("binds one instance, declares lazily, pins replication and drains once", async () => {
    isolate();
    let calls = 0;
    const primitive = lazySync((sync) => {
      calls++;
      return sync.mutex({ id: "lazy" });
    });
    const create = syncModule.createSync;
    let config: Parameters<typeof create>[0] | undefined;
    const createSpy = spyOn(syncModule, "createSync").mockImplementation((input) => {
      config = input;
      return create(input);
    });
    const runtime = await startProcessSync({ application: "test-app" });
    const drainSpy = spyOn(runtime.sync, "drain");
    try {
      expect(config?.defaults?.replicas).toBe(env.SYNC_REPLICAS);
      expect(calls).toBe(0);
      expect(primitive()).toBe(primitive());
      expect(calls).toBe(1);
      expect(getProcessSync()).toBe(runtime.sync);
      await expect(startProcessSync({ application: "second" })).rejects.toThrow("already");
      const first = runtime.stop();
      expect(runtime.stop()).toBe(first);
      await first;
      expect(drainSpy).toHaveBeenCalledTimes(1);
      expect(() => getProcessSync()).toThrow("not available");
    } finally {
      await runtime.stop();
      drainSpy.mockRestore();
      createSpy.mockRestore();
    }
  });

  test("retries a failed start with a fresh connection, fails at once on a Sync error, and starts cleanly later", async () => {
    isolate();
    const connect = nats.connectNats;
    const connections: Array<Awaited<ReturnType<typeof connect>>> = [];
    const connectSpy = spyOn(nats, "connectNats").mockImplementation(async (input) => {
      const connection = await connect(input);
      connections.push(connection);
      return connection;
    });
    const failures: Error[] = [];
    const create = syncModule.createSync;
    const createSpy = spyOn(syncModule, "createSync").mockImplementation((input) => {
      const sync = create(input);
      const failure = failures.shift();
      if (failure) spyOn(sync, "ready").mockRejectedValue(failure);
      return sync;
    });
    try {
      // JetStream that does not answer yet heals by waiting: the next attempt gets its own connection.
      failures.push(new Error("JetStream system temporarily unavailable"));
      const runtime = await startProcessSync({ application: "test-app" });
      expect(connections).toHaveLength(2);
      expect(connections[0]!.isClosed()).toBe(true);
      expect(getProcessSync()).toBe(runtime.sync);
      await runtime.stop();

      // A Sync error describes the server or declarations; waiting does not change it.
      connections.length = 0;
      failures.push(new syncModule.UnsupportedServerError("server fixture"));
      await expect(startProcessSync({ application: "test-app" })).rejects.toThrow("server fixture");
      expect(connections).toHaveLength(1);
      expect(connections[0]!.isClosed()).toBe(true);
      expect(() => getProcessSync()).toThrow("not available");
    } finally {
      createSpy.mockRestore();
      connectSpy.mockRestore();
    }
    const runtime = await startProcessSync({ application: "test-app" });
    await runtime.stop();
  });

  test("waits for NATS that becomes reachable after the process started", async () => {
    isolate();
    const proxy = await delayedNats();
    const servers = process.env.NATS_SERVERS;
    process.env.NATS_SERVERS = proxy.url;
    const delayMs = 1_500;
    const opening = setTimeout(proxy.open, delayMs);
    try {
      const startedAt = Date.now();
      const runtime = await startProcessSync({ application: "test-delayed" });
      try {
        expect(Date.now() - startedAt).toBeGreaterThanOrEqual(delayMs);
        expect(runtime.sync.health()).toMatchObject({ state: "ready", connection: "connected" });
      } finally {
        await runtime.stop();
      }
    } finally {
      clearTimeout(opening);
      process.env.NATS_SERVERS = servers;
      await proxy.close();
    }
  }, 20_000);
});

test("exits the process once NATS does not answer within the startup budget", async () => {
  const exit = spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`exit ${code}`);
  }) as typeof process.exit);
  let attempts = 0;
  try {
    const waiting = waitForNats(
      async () => {
        attempts++;
        throw new Error("connection refused");
      },
      { application: "test-budget", budgetMs: 1_500 },
    );
    await expect(waiting).rejects.toThrow("exit 1");
    expect(attempts).toBeGreaterThanOrEqual(2);
    expect(exit).toHaveBeenCalledWith(1);
  } finally {
    exit.mockRestore();
  }
});

// Stopping a NATS node needs a multi-node cluster and Docker control, which the shared test infrastructure does not provide.
test.skip("retains accepted topic events during one explicitly selected node outage", async () => {
  isolate();
  const container = "sync-test-nats-2";
  const docker = async (action: "stop" | "start") => {
    const child = Bun.spawn(["docker", action, container], { stdout: "pipe", stderr: "pipe" });
    const status = await child.exited;
    if (status !== 0) throw new Error(`docker ${action} ${container}: ${await new Response(child.stderr).text()}`);
  };
  const create = syncModule.createSync;
  let connection: Parameters<typeof create>[0]["connection"] | undefined;
  const createSpy = spyOn(syncModule, "createSync").mockImplementation((config) => {
    connection = config.connection;
    return create(config);
  });
  const runtime = await startProcessSync({ application: "test-failover" });
  let outageStarted = false;
  try {
    const topic = runtime.sync.topic<{ sequence: number }>({
      id: "continuity",
      retention: { maxAgeMs: 60_000, maxBytes: 1_048_576 },
      dedupeWindowMs: 60_000,
      maxPayloadBytes: 1024,
    });
    await runtime.sync.ready();
    await topic.publish({ data: { sequence: 1 } });
    outageStarted = true;
    await docker("stop");
    const second = await topic.publish({ data: { sequence: 2 } });
    const seen: number[] = [];
    for await (const event of topic.replay({ after: topic.cursorAt(0), until: second.cursor })) seen.push(event.data.sequence);
    expect(seen).toEqual([1, 2]);
    await docker("start");
    outageStarted = false;
    expect(runtime.sync.health().connection).toBe("connected");
  } finally {
    try {
      if (outageStarted) await docker("start");
      // Delete only stream names declared in this test's isolated namespace.
      for (const resource of await runtime.sync.resources()) {
        for (const name of resource.natsNames) {
          const response = await connection!.request(`$JS.API.STREAM.DELETE.${name}`, new Uint8Array(), { timeout: 10_000 });
          expect(JSON.parse(new TextDecoder().decode(response.data))).toMatchObject({ success: true });
        }
      }
    } finally {
      await runtime.stop();
      createSpy.mockRestore();
    }
  }
}, 60_000);
