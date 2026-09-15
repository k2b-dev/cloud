/** Disposable acceptance fixture for Cloud's shared runtime seams; no domain services. */
import { createSync } from "@k2b/sync";
import { connect } from "@nats-io/transport-node";
import { createHeartbeat } from "../src/_internal/heartbeat";
import { APP_REGISTRY_CONFIG } from "../src/_internal/registry";
import { watchRegistryChanges } from "../src/_internal/registry-watch";
import { FreeIpaTransportError, withFreeIpaResponse } from "../src/server/services/freeipa/transport";
import { superviseRuntimeTask } from "../src/services/runtime-lifecycle";

const namespace = process.env.RECOVERY_NAMESPACE!;
if (!namespace?.startsWith("cloud-runtime-acceptance-")) throw new Error("Disposable namespace required");
const connection = await connect({ servers: "nats://broker:4222", name: namespace });
const sync = createSync({ connection, namespace, application: "runtime-acceptance", defaults: { replicas: 1 } });
const registry = sync.ephemeral<{ id: string; baseUrl: string; boot: string }>(APP_REGISTRY_CONFIG);
const queue = sync.queue<number>({ id: "queue", delivery: { ackWaitMs: 1000, maxAttempts: 5, backoffMs: [100] } });
const topic = sync.topic<number>({ id: "topic", retention: { maxAgeMs: 3600000, maxBytes: 1048576 } });
const scheduler = sync.scheduler({ id: "scheduler", delivery: { maxAttempts: 1, backoffMs: [100] } });
await sync.ready();
const boot = crypto.randomUUID();
const counts = {
  http: 0,
  published: 0,
  queue: 0,
  topic: 0,
  watcher: 0,
  timer: 0,
  slots: 0,
  failedSlots: 0,
  ipaInvalid: 0,
  ipaTimeout: 0,
  queueErrors: 0,
  topicErrors: 0,
  watcherErrors: 0,
  timerErrors: 0,
  heartbeatErrors: 0,
  unexpectedFailures: 0,
};
const controller = new AbortController();
const tasks: Promise<void>[] = [];
let wedged = false;
let rejectHeartbeat = true;
let shuttingDown = false;
const server = Bun.serve({
  hostname: "0.0.0.0",
  port: 3000,
  fetch: async (request) => {
    const path = new URL(request.url).pathname;
    if (path === "/ipa-timeout") return new Promise<Response>(() => {});
    if (path === "/ipa-invalid") return Response.json({ unexpected: true });
    if (path === "/wedge" && request.method === "POST") {
      wedged = true;
      return Response.json({ wedged, boot });
    }
    counts.http++;
    const snapshot = await registry.snapshot({ prefix: "apps/core" });
    return Response.json({
      boot,
      counts,
      registered: snapshot.entries.some((e) => e.value.boot === boot),
      ttlMs: APP_REGISTRY_CONFIG.ttlMs,
    });
  },
});
const heartbeat = createHeartbeat(
  "core",
  { id: "core", baseUrl: "http://worker:3000", boot },
  {
    registry: {
      upsert: (input) => registry.upsert(input),
      delete: (input) => registry.delete(input),
      touch: (input) => {
        if (wedged) return new Promise<boolean>(() => {});
        if (rejectHeartbeat) {
          rejectHeartbeat = false;
          return Promise.reject(new Error("injected registry rejection"));
        }
        return registry.touch(input);
      },
    },
    onError: () => {
      counts.heartbeatErrors++;
    },
    onStale: () => {
      console.log(JSON.stringify({ event: "stale-exit", boot, counts }));
      process.exit(1);
    },
  },
);
await heartbeat.start();
const supervise = (run: (signal: AbortSignal) => Promise<void>, onError: (error: unknown) => void) => {
  tasks.push(superviseRuntimeTask({ signal: controller.signal, run, onError: ({ error }) => onError(error) }));
};
supervise(
  async (signal) => {
    const reader = await queue.reader();
    try {
      if (counts.queueErrors < 2) throw new Error("injected queue reader failure");
      while (!signal.aborted) {
        const delivery = await reader.receive({ waitMs: 1000 });
        if (delivery) {
          await delivery.ack();
          counts.queue++;
        }
      }
    } finally {
      await reader.close();
    }
  },
  () => {
    counts.queueErrors++;
  },
);
let cursor: string | undefined;
supervise(
  async (signal) => {
    for await (const event of topic.follow({ signal, after: cursor })) {
      if (counts.topicErrors < 2) throw new Error("injected topic reader failure");
      cursor = event.cursor;
      counts.topic++;
    }
  },
  () => {
    counts.topicErrors++;
  },
);
supervise(
  (signal) =>
    watchRegistryChanges({
      signal,
      watch: (currentSignal) => registry.watch({ prefix: "apps/", signal: currentSignal }),
      onChange: async () => {
        if (counts.watcherErrors < 2) throw new Error("injected watcher refresh failure");
        await registry.snapshot({ prefix: "apps/" });
        counts.watcher++;
      },
    }),
  () => {
    counts.watcherErrors++;
  },
);
supervise(
  async (signal) => {
    while (!signal.aborted) {
      await Bun.sleep(1000);
      if (counts.timerErrors < 2) throw new Error("injected async timer rejection");
      counts.timer++;
    }
  },
  () => {
    counts.timerErrors++;
  },
);
supervise(
  async (signal) => {
    while (!signal.aborted) {
      await Bun.sleep(1000);
      const value = ++counts.published;
      await queue.send({ data: value });
      await topic.publish({ data: value });
    }
  },
  (error) => {
    counts.unexpectedFailures++;
    console.error("Publisher failed", error);
  },
);
supervise(
  async (signal) => {
    await Bun.sleep(1000);
    const timeout = (counts.ipaInvalid + counts.ipaTimeout) % 2 === 1;
    await withFreeIpaResponse(
      `http://127.0.0.1:3000/ipa-${timeout ? "timeout" : "invalid"}`,
      {},
      async (response) => {
        await response.json();
        throw new FreeIpaTransportError("invalid_response", "injected invalid RPC response");
      },
      { signal, timeoutMs: 50 },
    );
  },
  (error) => {
    if (error instanceof FreeIpaTransportError && error.kind === "timeout") counts.ipaTimeout++;
    else if (error instanceof FreeIpaTransportError && error.kind === "invalid_response") counts.ipaInvalid++;
    else {
      counts.unexpectedFailures++;
      console.error("Unexpected FreeIPA failure", error);
    }
  },
);
await scheduler.create({
  id: "minute",
  cron: "* * * * *",
  timezone: "UTC",
  misfire: "latest",
  process: async () => {
    if (counts.failedSlots === 0) {
      counts.failedSlots++;
      throw new Error("injected scheduled slot failure");
    }
    counts.slots++;
  },
});
const worker = await scheduler.process({ concurrency: 1 });
console.log(JSON.stringify({ event: "ready", boot, ttlMs: APP_REGISTRY_CONFIG.ttlMs }));
process.on("SIGTERM", () => {
  if (shuttingDown) return;
  shuttingDown = true;
  void (async () => {
    controller.abort();
    worker.stop();
    await Promise.all(tasks);
    await heartbeat.stop();
    await sync.drain({ timeoutMs: 10000 });
    await connection.drain();
    await server.stop(true);
    console.log(JSON.stringify({ event: "clean-shutdown", boot, counts }));
    process.exit(0);
  })().catch((error) => {
    console.error(error);
    process.exit(2);
  });
});
