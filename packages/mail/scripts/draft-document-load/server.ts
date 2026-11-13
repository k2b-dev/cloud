import { spyOn } from "bun:test";
import { rename, writeFile } from "node:fs/promises";
import { loadavg } from "node:os";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { auth } from "@k2b/cloud/server";
import { toBase64 } from "@k2b/cloud/shared-text";
import type { Result } from "@k2b/stdlib";
import type { Lock, Mutex, TopicConfig } from "@k2b/sync";
import { Hono } from "hono";
import { websocket } from "hono/bun";
import type { MailApiContext } from "../../src/api/public-resource-boundary";
import type { MailRequestContext } from "../../src/service/auth";
import { draftDocumentDiagnostics, draftTrace, draftTraceSpan, draftUpdateId } from "../../src/service/draft-document-diagnostics";
import type { Options } from "../draft-document-load";
import { checkHost, within, writeSample } from "./common";

const value = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(result.error.message);
  return result.data;
};
const { options, out, primaryOut }: { options: Options; out: string; primaryOut?: string } = await Bun.file(Bun.argv[2]!).json();
await writeFile(`${out}/server-pid.json`, JSON.stringify({ pid: process.pid }));
const ackBudgetMs = 30000;
const cleanup: Array<() => unknown | Promise<unknown>> = [];
const cleanupWork = new Map<symbol, { label: string; docId: string; started: number }>();
const trackCleanupWork = <T>(label: string, docId: string, work: () => Promise<T>): Promise<T> => {
  const key = Symbol();
  cleanupWork.set(key, { label, docId, started: performance.now() });
  return Promise.resolve()
    .then(work)
    .finally(() => cleanupWork.delete(key));
};
const done = Promise.withResolvers<void>();
let failure: string | undefined;
const stop = () => {
  failure ??= "Supervisor stopped server";
  done.resolve();
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
const loop = monitorEventLoopDelay({ resolution: 10 });
loop.enable();
const traceFile = Bun.file(`${out}/server-trace.ndjson`).writer();
let traceBytes = 0;
const listener = (data: unknown) => {
  const line = `${JSON.stringify(data)}\n`;
  // Diagnostic artifacts get 256 MiB of the load run's disk budget.
  traceBytes += Buffer.byteLength(line);
  if (traceBytes > 256 * 1024 ** 2) {
    failure ??= "Server trace disk budget exceeded";
    done.resolve();
    return;
  }
  traceFile.write(line);
};
draftDocumentDiagnostics.subscribe(listener);
let timer: ReturnType<typeof setInterval> | undefined;
let waitForSecondary: (() => Promise<void>) | undefined;
let sampled: Promise<void> = Promise.resolve();
let finalState: unknown, inspect: (() => { sockets: number; buffers: unknown }) | undefined, afterGc: unknown;
let endMemory: NodeJS.MemoryUsage | undefined;
let peakRss = 0,
  peakHeap = 0;
const initialMemory = process.memoryUsage();
try {
  const { requireInfra, createDisposableDatabase } = await import("../../../../scripts/fixtures/test-infra");
  await requireInfra("database", "nats", "valkey");
  const shared:
    | {
        databaseUrl: string;
        namespace: string;
        user: { id: string };
        mailboxId: string;
        identity: { id: string };
        drafts: Array<{ id: string; short_id: string; state: string; cursor: string | null; generation: string }>;
      }
    | undefined = primaryOut ? await Bun.file(`${primaryOut}/cluster.json`).json() : undefined;
  const database = shared ? undefined : await createDisposableDatabase("mail_draft_load");
  if (database) cleanup.push(() => database.drop());
  process.env.DATABASE_URL = shared?.databaseUrl ?? database!.url;
  const namespace = shared?.namespace ?? `test-mail-draft-load-${crypto.randomUUID()}`;
  process.env.SYNC_NAMESPACE = namespace;
  const { initializeTestPlatform } = await import("../../../../scripts/fixtures/platform");
  const { closePlatformClients } = await import("../../../cloud/src/runtime/clients");
  cleanup.push(closePlatformClients);
  const { stopDraftDocumentCancellation } = await import("../../src/service/draft-document-socket-sql");
  cleanup.push(stopDraftDocumentCancellation);
  await initializeTestPlatform("mail");
  const { deleteTestNamespace } = await import("../../../../scripts/fixtures/test-sync");
  if (!shared) {
    cleanup.push(() => deleteTestNamespace(namespace));
    // This node owns the shared DB/namespace, but its own failure can stop it
    // first. The supervisor drains the other node before releasing this gate.
    waitForSecondary = async () => {
      if (!(await Bun.file(`${out}/node-2/server-pid.json`).exists())) return;
      await within(
        (async () => {
          while (!(await Bun.file(`${out}/secondary-stopped.json`).exists())) await Bun.sleep(25);
        })(),
        90_000,
        "Secondary cleanup before shared resources",
      );
    };
  }
  const { sql, startProcessSync } = await import("@k2b/cloud");
  const runtime = await startProcessSync({ application: "mail" });
  cleanup.push(() => runtime.stop());
  const { runCoreSetup } = await import("../../../core/src/runtime-helpers");
  if (!shared) await runCoreSetup();
  const { migrate } = await import("../../src/migrate");
  if (!shared) await migrate();
  const { createAppEventTestHarness } = await import("@k2b/cloud/events/testing");
  const { mailCapabilities } = await import("../../src/capabilities");
  createAppEventTestHarness("mail", mailCapabilities);
  await sql`INSERT INTO mail.draft_document_log_policy (log_id) VALUES ('cloud:mail:draft-documents') ON CONFLICT DO NOTHING`;
  const { appRegistry } = await import("../../../cloud/src/_internal/registry");
  await appRegistry().upsert({
    key: "apps/mail",
    value: {
      id: "mail",
      name: "Mail",
      icon: "ti ti-mail",
      description: "Isolated Mail load fixture",
      baseUrl: "http://mail.test:3000",
      routes: ["/api/mail"],
    },
  });
  const transport = await import("../../src/api/draft-document-socket");
  cleanup.push(transport.stopMailDraftConnections);
  const { readDraftDocument } = await import("../../src/service/draft-documents");
  const { createMailbox } = await import("../../src/service/mailboxes");
  const { newShortId } = await import("../../src/lib/short-id");
  const uid = `draft-load-${newShortId()}`;
  const user =
    shared?.user ??
    (
      await sql<{ id: string }[]>`INSERT INTO auth.users (uid, provider, profile, display_name, mail)
      VALUES (${uid}, 'local', 'user', 'Load Person', 'load@example.test') RETURNING id`
    )[0];
  if (!user) throw new Error("Missing fixture user");
  const context: MailRequestContext = {
    actor: {
      kind: "user",
      user: {
        id: user.id,
        uid,
        provider: "local",
        profile: "user",
        roles: ["user"],
        displayName: "Load Person",
        givenname: "Load",
        sn: "Person",
        mail: "load@example.test",
        avatarHash: null,
        accountExpires: null,
        lastLoginLocal: null,
        ipa: null,
        memberofGroup: [],
        memberofGroupIds: [],
        manages: [],
        managesGroupIds: [],
      },
    },
    accessSubject: { type: "user", userId: user.id },
  };
  if (context.actor.kind !== "user") throw new Error("Expected fixture user");
  const session = {
    data: { userId: user.id, sid: "load", authEpoch: 0, expiresAt: "2100-01-01T00:00:00.000Z", kind: "web" as const },
    user: context.actor.user,
  };
  const authentication = spyOn(auth.session, "authenticate").mockImplementation(async (token) =>
    token === "load-session" ? session : null,
  );
  cleanup.push(() => authentication.mockRestore());
  const mailboxId =
    shared?.mailboxId ?? value(await createMailbox(context, { name: "Draft load", description: "Isolated load fixture" })).id;
  const identity =
    shared?.identity ??
    (
      await sql<{ id: string }[]>`INSERT INTO mail.sender_identities
      (short_id, mailbox_id, label, display_name, from_address, automation_policy, status)
      VALUES (${newShortId()}, ${mailboxId}::uuid, 'Load', 'Load', 'load@example.test', 'disabled', 'verified') RETURNING id`
    )[0];
  if (!identity) throw new Error("Missing sender");
  if (!shared) {
    const { prepareDraftSendBinding } = await import("../../test/fixtures/draft-send");
    await prepareDraftSendBinding(mailboxId, identity.id);
  }

  const sync = (await import("@k2b/cloud")).getProcessSync();
  const originalMutex = sync.mutex.bind(sync);
  const mutexSpy = spyOn(sync, "mutex").mockImplementation((config) => {
    const mutex = originalMutex(config);
    if (config.id === "cloud:mail:draft-documents:snapshot-writer") {
      const withLock = mutex.withLock.bind(mutex);
      mutex.withLock = <T>(input: Parameters<Mutex["withLock"]>[0], operation: (lock: Lock) => Promise<T>) =>
        trackCleanupWork("snapshot lock", input.resource, () =>
          withLock(input, (lock) => trackCleanupWork("snapshot write", input.resource, () => operation(lock))),
        );
    }
    if (config.id === "cloud:mail:draft-documents:admission") {
      const withLock = mutex.withLock.bind(mutex);
      mutex.withLock = <T>(input: Parameters<Mutex["withLock"]>[0], operation: (lock: Lock) => Promise<T>) => {
        const start = performance.now();
        return draftTraceSpan("admission_total", () =>
          withLock(input, async (lock) => {
            draftTrace("admission_wait", { durationMs: performance.now() - start, outcome: "ok" });
            return draftTraceSpan("admission_operation", () => operation(lock));
          }),
        );
      };
    }
    return mutex;
  });
  cleanup.push(() => mutexSpy.mockRestore());
  const originalTopic = sync.topic.bind(sync);
  const topicSpy = spyOn(sync, "topic").mockImplementation(<T>(config: TopicConfig) => {
    const topic = originalTopic<T>(config);
    if (config.id === "cloud:mail:draft-documents") {
      const publish = topic.publish.bind(topic),
        latest = topic.latestCursor.bind(topic),
        replay = topic.replay.bind(topic),
        hub = topic.hub.bind(topic);
      topic.publish = (input) => draftTraceSpan("jetstream_publish_ack", () => publish(input));
      topic.latestCursor = (input) => draftTraceSpan("broker_lookup", () => latest(input));
      topic.hub = (input) => {
        const current = hub(input);
        return {
          close: () => current.close(),
          subscribe: (options) => ({
            async *[Symbol.asyncIterator]() {
              for await (const event of current.subscribe(options)) {
                const data = event.data;
                if (
                  data &&
                  typeof data === "object" &&
                  "kind" in data &&
                  data.kind === "sync" &&
                  "payload" in data &&
                  typeof data.payload === "string"
                )
                  draftTrace("broker_fanout", { updateId: draftUpdateId(data.payload), peerId: undefined, role: "delivery" });
                yield event;
              }
            },
          }),
        };
      };
      topic.replay = (input) => ({
        async *[Symbol.asyncIterator]() {
          const start = performance.now();
          let events = 0;
          let outcome: "ok" | "error" = "ok";
          let errorName: string | undefined;
          draftTrace("broker_replay:start");
          try {
            for await (const event of replay(input)) {
              events++;
              yield event;
            }
          } catch (error) {
            outcome = "error";
            errorName = error instanceof Error ? error.name : "UnknownError";
            throw error;
          } finally {
            draftTrace("broker_replay:end", { durationMs: performance.now() - start, events, outcome, errorName });
          }
        },
      });
    }
    return topic;
  });
  cleanup.push(() => topicSpy.mockRestore());
  const { createSql } = await import("@k2b/cloud");
  const meter = createSql({ max: 1 });
  cleanup.push(() => meter.close());
  await meter`CREATE EXTENSION IF NOT EXISTS pg_stat_statements`;
  const drafts = new Map<string, { id: string; short_id: string; state: string; cursor: string | null; generation: string }>();
  if (shared) for (const row of shared.drafts) drafts.set(row.short_id, row);
  else
    for (let i = 0; i < options.drafts; i++) {
      checkHost();
      const [row] = await sql<{ id: string; short_id: string }[]>`INSERT INTO mail.drafts
        (short_id, mailbox_id, sender_identity_id, author_kind, author_id, last_editor_kind, last_editor_id,
         to_addresses, cc_addresses, bcc_addresses, subject, body_markdown, body_format, priority, edit_mode)
        VALUES (${newShortId()}, ${mailboxId}::uuid, ${identity.id}::uuid, 'user', ${user.id}::uuid, 'user', ${user.id}::uuid,
        '[{"address":"recipient@example.test","name":null}]'::jsonb, '[]'::jsonb, '[]'::jsonb, 'Load', ${"x".repeat(options.bodyBytes)}, 'plain', 'normal', 'shared') RETURNING id, short_id`;
      if (!row) throw new Error("Missing draft");
      const base = value(await readDraftDocument({ context, mailboxId, draftId: row.id }));
      drafts.set(row.short_id, { ...row, state: toBase64(base.durable.state), cursor: base.durable.cursor, generation: base.generation });
    }
  const { draftDocumentSnapshots, flushDraftDocumentSnapshot, stopDraftDocumentSnapshots } = await import(
    "../../src/service/draft-document-snapshots"
  );
  const flushNow = draftDocumentSnapshots.flushNow.bind(draftDocumentSnapshots);
  const flushSpy = spyOn(draftDocumentSnapshots, "flushNow").mockImplementation((docId, options) =>
    trackCleanupWork("snapshot flush", docId, () => flushNow(docId, options)),
  );
  cleanup.push(() => flushSpy.mockRestore());
  await draftDocumentSnapshots.start();
  cleanup.push(stopDraftDocumentSnapshots);
  const { startLiveOutbox } = await import("@k2b/cloud/events/testing");
  let stopLive = await startLiveOutbox("mail");
  cleanup.push(async () => {
    await stopLive?.();
  });
  let probing = false;
  const { migrateDraftDocumentLogPolicy, stopDraftDocumentLogPolicy } = await import("../../src/service/draft-document-log-policy");
  await migrateDraftDocumentLogPolicy();
  cleanup.push(stopDraftDocumentLogPolicy);
  if (!shared)
    await writeFile(
      `${out}/cluster.json`,
      JSON.stringify({ databaseUrl: process.env.DATABASE_URL, namespace, user, mailboxId, identity, drafts: [...drafts.values()] }),
      { mode: 0o600 },
    );
  const requestAborts = new Map<string, AbortController>();
  const app = new Hono<MailApiContext>()
    .use("/drafts/:draftId/socket", async (c, next) => {
      const draft = drafts.get(c.req.param("draftId") ?? "");
      if (!draft) return c.notFound();
      c.set("actor", context.actor);
      c.set("accessSubject", context.accessSubject);
      c.set("credentialKind", "session");
      c.set("internalMailboxId", mailboxId);
      c.set("internalDraftId", draft.id);
      await next();
    })
    .get("/drafts/:draftId/socket", transport.upgradeMailDraftDocumentSocket)
    .post("/__load/abort", async (c) => {
      requestAborts.get(c.req.query("connection") ?? "")?.abort();
      return c.json({ ok: true });
    })
    .post("/__load/probe/pause", async (c) => {
      probing = true;
      await sampled;
      await stopLive?.();
      stopLive = null;
      return c.json({ ok: true });
    })
    .post("/__load/probe/resume", async (c) => {
      stopLive = await startLiveOutbox("mail");
      probing = false;
      return c.json({ ok: true });
    })
    .get("/__load/probe/counter", async (c) => {
      const [row] = await meter<{ calls: string }[]>`SELECT COALESCE(sum(calls), 0)::text AS calls FROM pg_stat_statements
        WHERE dbid=(SELECT oid FROM pg_database WHERE datname=current_database()) AND query NOT LIKE '%pg_stat_statements%'`;
      return c.json({ calls: Number(row?.calls ?? 0) });
    })
    .post("/__load/send", async (c) => {
      const { draftId, visible } = await c.req.json<{ draftId: string; visible: string }>();
      if (![...drafts.values()].some((row) => row.id === draftId)) return c.notFound();
      await flushDraftDocumentSnapshot(draftId);
      const current = value(await readDraftDocument({ context, mailboxId, draftId }));
      if (current.durable.content.body !== visible) throw new Error("Fast send does not cover the visible input");
      const { reviewDraftComposeSafety } = await import("../../src/service/compose-safety");
      const checked = value(await reviewDraftComposeSafety({ context, mailboxId, draftId, expectedRevision: current.revision }));
      const { createActorCommand } = await import("../../src/service/commands");
      const command = value(
        await createActorCommand({
          context,
          mailboxId,
          enqueue: false,
          input: {
            kind: "send",
            draftId,
            senderIdentityId: identity.id,
            expectedDraftRevision: current.revision,
            expectedContentHash: checked.contentHash,
            undoSeconds: 60,
            idempotencyKey: crypto.randomUUID(),
            safetyApproval: { revision: checked.revision, fingerprint: checked.fingerprint, warningIds: checked.warnings.map((w) => w.id) },
          },
        }),
      );
      const [outbox] = await sql<{ id: string; draft_snapshot: { body: string } }[]>`SELECT id, draft_snapshot
        FROM mail.outbox_submissions WHERE command_id = ${command.id}::uuid`;
      if (!outbox || outbox.draft_snapshot.body !== visible) throw new Error("Fast send snapshot differs from visible text");
      return c.json({ scheduledSendId: outbox.id, body: outbox.draft_snapshot.body });
    })
    .post("/__load/undo", async (c) => {
      const { scheduledSendId } = await c.req.json<{ scheduledSendId: string }>();
      const { cancelScheduledSend } = await import("../../src/service/scheduled-sends");
      const cancelled = value(await cancelScheduledSend({ context, mailboxId, scheduledSendId, input: { disposition: "draft" } }));
      const current = value(await readDraftDocument({ context, mailboxId, draftId: cancelled.draftId }));
      return c.json({ generation: current.generation, cursor: current.durable.cursor, state: toBase64(current.durable.state) });
    })
    .post("/__load/revoke", async (c) => {
      await sql`DELETE FROM mail.mailbox_access WHERE mailbox_id = ${mailboxId}::uuid`;
      const { mailLive } = await import("../../src/service/live");
      mailLive.wake();
      return c.json({ ok: true });
    })
    .post("/__load/finish", async (c) => {
      try {
        const bodies: Array<{ id: string; bodies: string[] }> = await c.req.json();
        for (const item of bodies) {
          await flushDraftDocumentSnapshot(item.id);
          const saved = value(await within(readDraftDocument({ context, mailboxId, draftId: item.id }), 30000, "Convergence"));
          if (item.bodies.some((body) => body !== saved.durable.content.body)) throw new Error("Final document divergence");
        }
        return c.json({ ok: true });
      } catch (e) {
        failure = String(e);
        done.resolve();
        return c.json({ error: failure }, 500);
      }
    })
    .post("/__load/stop", (c) => {
      setTimeout(() => done.resolve(), 100);
      return c.json({ ok: true });
    });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    fetch: async (request, runtime) => {
      const controller = new AbortController();
      const key = new URL(request.url).searchParams.get("connection");
      if (key && new URL(request.url).pathname.endsWith("/socket")) requestAborts.set(key, controller);
      Object.defineProperty(request, "signal", { value: AbortSignal.any([request.signal, controller.signal]) });
      const response = await app.fetch(request, runtime);
      if (response?.status >= 400) console.error(`HANDSHAKE_${response.status}`);
      return response;
    },
    websocket,
  });
  cleanup.push(() => server.stop(true));
  const port = server.port;
  if (!port) throw new Error("Missing socket server port");
  cleanup.push(transport.stopMailDraftConnections);
  const { connectTestNats } = await import("../../../../scripts/fixtures/test-nats");
  const broker = await connectTestNats();
  cleanup.push(() => broker.close());
  const readState = () =>
    within(
      (async () => {
        const [state] = await meter`SELECT
        (SELECT count(*)::int FROM mail.drafts) AS drafts,
        (SELECT coalesce(sum(octet_length(doc_state)),0)::bigint::text FROM mail.drafts) AS document_bytes,
        (SELECT count(*)::int FROM mail.draft_document_revisions) AS revisions,
        (SELECT coalesce(sum(octet_length(state)),0)::bigint::text FROM mail.draft_document_revisions) AS revision_bytes,
        (SELECT pg_total_relation_size('mail.drafts'))::text AS drafts_relation_bytes,
        (SELECT pg_total_relation_size('mail.draft_document_revisions'))::text AS revisions_relation_bytes,
        (SELECT count(*)::int FROM mail.draft_document_freezes) AS freezes,
        (SELECT count(*)::int FROM mail.draft_document_rests) AS rests`;
        const streams = (await broker.request("$JS.API.STREAM.LIST", JSON.stringify({ offset: 0 }), { timeout: 3000 })).json<{
          total?: number;
          error?: { description?: string };
          streams?: {
            config: { name: string; metadata?: Record<string, string> };
            state: { bytes: number; messages: number; consumer_count: number };
          }[];
        }>();
        if (streams.error) throw new Error("JetStream stream statistics unavailable");
        if ((streams.total ?? 0) > (streams.streams?.length ?? 0))
          throw new Error("JetStream statistics exceed one isolated namespace page");
        const topics = (streams.streams ?? [])
          .filter(
            (s) =>
              s.config.metadata?.["sync.namespace"] === namespace &&
              Object.values(s.config.metadata ?? {}).some(
                (v) => v === "cloud:mail:draft-documents" || v === "cloud:mail:draft-document-awareness",
              ),
          )
          .map((s) => ({ stream: s.config.name, metadata: s.config.metadata, ...s.state }));
        return { database: state, topics };
      })(),
      ackBudgetMs,
      "Statistics SQL/broker read",
    );

  inspect = () => ({ sockets: server.pendingWebSockets, buffers: transport.mailDraftConnectionStats() });
  let cpu = process.cpuUsage(),
    sampling = false;
  const sample = async () => {
    checkHost();
    const memory = process.memoryUsage();
    peakRss = Math.max(peakRss, memory.rss);
    peakHeap = Math.max(peakHeap, memory.heapUsed);
    if (memory.rss > options.rssMib * 1024 ** 2)
      throw new Error(`Server RSS budget exceeded: ${(memory.rss / 1024 ** 2).toFixed(1)} MiB > ${options.rssMib} MiB`);
    const usage = process.cpuUsage(cpu);
    cpu = process.cpuUsage();
    const activity =
      await meter`SELECT state, wait_event_type, wait_event, count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() GROUP BY 1,2,3`;
    writeSample(`${out}/server-samples.ndjson`, {
      at: Date.now(),
      memory,
      cpu: usage,
      hostLoad: loadavg()[0],
      eventLoopMs: { mean: loop.mean / 1e6, p95: loop.percentile(95) / 1e6, max: loop.max / 1e6 },
      ...inspect?.(),
      activity,
      ...(await readState()),
    });
  };
  await sample();
  timer = setInterval(() => {
    if (sampling || probing) return;
    sampling = true;
    sampled = sample()
      .catch((e) => {
        failure = String(e);
        done.resolve();
      })
      .finally(() => {
        sampling = false;
      });
  }, 1000);
  if (!shared) await meter`SELECT pg_stat_statements_reset(0, oid, 0) FROM pg_database WHERE datname=current_database()`;
  await writeFile(`${out}/ready.json`, JSON.stringify({ pid: process.pid, port, userId: user.id, drafts: [...drafts.values()] }));
  await done.promise;
  finalState = await readState();
  const totals =
    await meter`SELECT sum(calls)::text AS calls, sum(total_exec_time) AS execution_ms FROM pg_stat_statements WHERE dbid=(SELECT oid FROM pg_database WHERE datname=current_database())`;
  await writeFile(`${out}/sql-totals.json`, JSON.stringify(totals, null, 2));
  const statements =
    await meter`SELECT calls::int, total_exec_time, mean_exec_time, rows::text, query FROM pg_stat_statements WHERE dbid=(SELECT oid FROM pg_database WHERE datname=current_database()) ORDER BY total_exec_time DESC LIMIT 25`;
  await writeFile(`${out}/sql-statements.json`, JSON.stringify(statements, null, 2));
} catch (e) {
  failure = e instanceof Error ? e.message : String(e);
} finally {
  // Report the initiating failure before teardown changes what peers observe.
  await writeFile(`${out}/stopping.tmp`, JSON.stringify({ failure: failure ?? "Server stopped before clients completed" }));
  await rename(`${out}/stopping.tmp`, `${out}/stopping.json`);
  endMemory = process.memoryUsage();
  if (timer) clearInterval(timer);
  await within(sampled, 30000, "Sampler").catch(() => undefined);
  await waitForSecondary?.();
  for (const [index, action] of cleanup.reverse().entries()) {
    const label = action.name || action.toString().split("\n")[0];
    const started = performance.now();
    const pending = () => [...cleanupWork.values()].map((entry) => ({ ...entry, ageMs: performance.now() - entry.started }));
    writeSample(`${out}/cleanup.ndjson`, { index, label, phase: "start", pending: pending() });
    try {
      await within(Promise.resolve().then(action), 10000, `Cleanup ${label}`);
      writeSample(`${out}/cleanup.ndjson`, { index, label, phase: "done", durationMs: performance.now() - started });
    } catch (e) {
      failure ??= String(e);
      writeSample(`${out}/cleanup.ndjson`, {
        index,
        label,
        phase: "failed",
        durationMs: performance.now() - started,
        error: String(e),
        pending: pending(),
      });
    }
  }
  Bun.gc(true);
  await Bun.sleep(250);
  Bun.gc(true);
  afterGc = process.memoryUsage();
  loop.disable();
  draftDocumentDiagnostics.unsubscribe(listener);
  await traceFile.end();
  await writeFile(
    `${out}/server-summary.json`,
    JSON.stringify(
      {
        pid: process.pid,
        failure,
        memory: { initial: initialMemory, peakRss, peakHeap, end: endMemory, afterGc },
        finalSockets: inspect?.(),
        finalState,
        eventLoopMs: { mean: loop.mean / 1e6, p95: loop.percentile(95) / 1e6, max: loop.max / 1e6 },
      },
      null,
      2,
    ),
  );
  process.exit(failure ? 1 : 0);
}
