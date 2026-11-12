import { spyOn } from "bun:test";
import { appendFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { loadavg } from "node:os";
import { dirname, resolve } from "node:path";
import { auth } from "@k2b/cloud/server";
import { fromBase64, toBase64 } from "@k2b/cloud/shared-text";
import type { Result } from "@k2b/stdlib";
import { Hono } from "hono";
import { websocket } from "hono/bun";
import { Awareness, encodeAwarenessUpdate, outdatedTimeout } from "y-protocols/awareness";
import * as Y from "yjs";
import type { MailApiContext } from "../../src/api/public-resource-boundary";
import { mailDraftDocumentMessageSchema } from "../../src/lib/draft-document-protocol";
import type { MailRequestContext } from "../../src/service/auth";
import type { Options } from "../draft-document-load";

const value = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(result.error.message);
  return result.data;
};
const MiB = 1024 ** 2;
// Match the browser provider: one standard awareness expiry window without acknowledgement.
const ackBudgetMs = outdatedTimeout;
// A stalled SQL driver must produce an artifact rather than wedge the load tool.
const within = async <T>(work: Promise<T>, milliseconds: number, label: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} exceeded ${milliseconds} ms`)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};
// lib.dom hides Bun's headers constructor and abrupt terminate(); this is the
// runtime-specific transport boundary, matching the integration socket fixture.
interface NativeSocket extends WebSocket {
  terminate(): void;
}
const NativeWebSocket = WebSocket as unknown as new (url: string, options: Bun.WebSocketOptions) => NativeSocket;
const maskedFrame = (text: string) => {
  const payload = Buffer.from(text);
  if (payload.length >= 126) throw new Error("Slow-consumer handshake frame too large");
  const mask = Buffer.from([1, 2, 3, 4]);
  return Buffer.concat([Buffer.from([0x81, 0x80 | payload.length]), mask, Buffer.from(payload.map((b, i) => b ^ mask[i % 4]!))]);
};

/** Same disposable platform and socket boot as the integration fixture; only browser credential verification is replaced. */
export async function run(options: Options) {
  const out = resolve(options.out ?? `.local/mail-draft-load/${new Date().toISOString().replaceAll(":", "-")}`);
  await mkdir(dirname(out), { recursive: true });
  await mkdir(out);
  const samples = `${out}/samples.ndjson`;
  const cleanup: Array<() => unknown | Promise<unknown>> = [];
  const abort = new AbortController();
  const interrupt = () => abort.abort(new Error("Interrupted"));
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  const errors: Record<string, number> = {};
  const closes: Record<string, number> = {};
  const scenarios = { reconnects: 0, abruptDisconnects: 0, requestAborts: 0, slowConsumers: 0 };
  const error = (code: string) => {
    errors[code] = (errors[code] ?? 0) + 1;
  };
  const histogram = new Uint32Array(6001); // 0..60 s, 10 ms buckets, constant space.
  let observations = 0,
    editCount = 0,
    peakRss = 0,
    peakHeap = 0;
  let started = 0,
    ended = 0,
    initialMemory: NodeJS.MemoryUsage | undefined,
    endMemory: NodeJS.MemoryUsage | undefined;
  let afterGc: NodeJS.MemoryUsage | undefined, finalState: unknown, finalSockets: unknown, failure: string | undefined;
  let sampleTimer: ReturnType<typeof setInterval> | undefined;
  let sampled: Promise<void> = Promise.resolve();
  let inspectSockets: (() => unknown) | undefined;
  let inspectState: (() => Promise<unknown>) | undefined;
  const check = () => {
    abort.signal.throwIfAborted();
    if (errors.BACKPRESSURE) throw new Error("Server admission or buffer budget reached (BACKPRESSURE)");
    const unexpected = Object.keys(errors).find((code) => code !== "STREAM_FAILED");
    if (unexpected) throw new Error(`Unexpected client error: ${unexpected}`);
    if ((errors.STREAM_FAILED ?? 0) > scenarios.requestAborts) throw new Error("Unexpected server stream failure");
    if ((loadavg()[0] ?? 0) > 40) throw new Error("Host one-minute load exceeds 40");
    if (process.memoryUsage().rss > options.rssMib * MiB) throw new Error("Process RSS budget exceeded");
  };
  try {
    check();
    const { requireInfra, createDisposableDatabase } = await import("../../../../scripts/fixtures/test-infra");
    await requireInfra("database", "nats", "valkey");
    const database = await createDisposableDatabase("mail_draft_load");
    cleanup.push(() => database.drop());
    process.env.DATABASE_URL = database.url;
    const namespace = `test-mail-draft-load-${crypto.randomUUID()}`;
    process.env.SYNC_NAMESPACE = namespace;
    const { initializeTestPlatform } = await import("../../../../scripts/fixtures/platform");
    const { closePlatformClients } = await import("../../../cloud/src/runtime/clients");
    cleanup.push(closePlatformClients);
    await initializeTestPlatform("mail");
    const { deleteTestNamespace } = await import("../../../../scripts/fixtures/test-sync");
    cleanup.push(() => deleteTestNamespace(namespace));
    const { sql, startProcessSync } = await import("@k2b/cloud");
    const runtime = await startProcessSync({ application: "mail" });
    cleanup.push(() => runtime.stop());
    const { runCoreSetup } = await import("../../../core/src/runtime-helpers");
    await runCoreSetup();
    const { migrate } = await import("../../src/migrate");
    await migrate();
    const { createAppEventTestHarness } = await import("@k2b/cloud/events/testing");
    const { mailCapabilities } = await import("../../src/capabilities");
    createAppEventTestHarness("mail", mailCapabilities);
    await sql`INSERT INTO mail.draft_document_log_policy (log_id) VALUES ('cloud:mail:draft-documents') ON CONFLICT DO NOTHING`;
    const transport = await import("../../src/api/draft-document-socket");
    cleanup.push(transport.stopMailDraftConnections);
    const { readDraftDocument } = await import("../../src/service/draft-documents");
    const { createMailbox } = await import("../../src/service/mailboxes");
    const { newShortId } = await import("../../src/lib/short-id");
    const uid = `draft-load-${newShortId()}`;
    const [user] = await sql<{ id: string }[]>`INSERT INTO auth.users (uid, provider, profile, display_name, mail)
      VALUES (${uid}, 'local', 'user', 'Load Person', 'load@example.test') RETURNING id`;
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
    const mailboxId = value(await createMailbox(context, { name: "Draft load", description: "Isolated load fixture" })).id;
    const [identity] = await sql<{ id: string }[]>`INSERT INTO mail.sender_identities
      (short_id, mailbox_id, label, display_name, from_address, automation_policy, status)
      VALUES (${newShortId()}, ${mailboxId}::uuid, 'Load', 'Load', 'load@example.test', 'disabled', 'verified') RETURNING id`;
    if (!identity) throw new Error("Missing sender");
    type Pending = { at: number; marker: string; waiting: Set<number> };
    type Draft = { id: string; short_id: string; pending: Map<string, Pending>; clients: Client[] };
    type Client = {
      index: number;
      doc: Y.Doc;
      awareness: Awareness;
      socket?: NativeSocket;
      cursor: string | null;
      generation: string;
      ready: boolean;
      pending: string | null;
      sentAt: number;
      pendingBase: string | null;
      sequence: number;
      next: number;
    };
    const drafts = new Map<string, Draft>();
    cleanup.push(() => {
      for (const d of drafts.values())
        for (const c of d.clients) {
          c.awareness.destroy();
          c.doc.destroy();
        }
    });
    for (let i = 0; i < options.drafts; i++) {
      check();
      const [row] = await sql<{ id: string; short_id: string }[]>`INSERT INTO mail.drafts
        (short_id, mailbox_id, sender_identity_id, author_kind, author_id, last_editor_kind, last_editor_id,
         to_addresses, cc_addresses, bcc_addresses, subject, body_markdown, body_format, priority, edit_mode)
        VALUES (${newShortId()}, ${mailboxId}::uuid, ${identity.id}::uuid, 'user', ${user.id}::uuid, 'user', ${user.id}::uuid,
        '[{"address":"recipient@example.test","name":null}]'::jsonb, '[]'::jsonb, '[]'::jsonb, 'Load', ${"x".repeat(options.bodyBytes)}, 'plain', 'normal', 'shared') RETURNING id, short_id`;
      if (!row) throw new Error("Missing draft");
      // Seed through the real service before the concurrent clients start.
      const base = value(await readDraftDocument({ context, mailboxId, draftId: row.id }));
      const draft: Draft = { ...row, pending: new Map(), clients: [] };
      drafts.set(row.short_id, draft);
      for (let j = 0; j < options.clients; j++) {
        const doc = new Y.Doc();
        doc.clientID = 1 + i * options.clients + j;
        Y.applyUpdate(doc, base.durable.state);
        const awareness = new Awareness(doc);
        awareness.setLocalState({ cursor: null });
        draft.clients.push({
          index: j,
          doc,
          awareness,
          cursor: base.durable.cursor,
          generation: base.generation,
          ready: false,
          pending: null,
          sentAt: 0,
          pendingBase: null,
          sequence: 0,
          next: 0,
        });
      }
    }

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
      .get("/drafts/:draftId/socket", transport.upgradeMailDraftDocumentSocket);
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      idleTimeout: 0,
      fetch: async (request, runtime) => {
        const controller = new AbortController();
        const key = new URL(request.url).searchParams.get("connection");
        if (key) requestAborts.set(key, controller);
        Object.defineProperty(request, "signal", { value: AbortSignal.any([request.signal, controller.signal]) });
        const response = await app.fetch(request, runtime);
        if (response?.status >= 400) error(`HANDSHAKE_${response.status}`);
        return response;
      },
      websocket,
    });
    cleanup.push(() => server.stop(true));
    const port = server.port;
    if (!port) throw new Error("Missing socket server port");
    cleanup.push(async () => {
      for (const d of drafts.values()) for (const c of d.clients) c.socket?.terminate();
      await transport.stopMailDraftConnections();
    });
    const send = (c: Client, packet: unknown) => {
      if (c.socket?.readyState === 1) c.socket.send(JSON.stringify(packet));
    };
    const connect = async (d: Draft, c: Client) => {
      c.ready = false;
      const key = `${d.short_id}-${c.index}`;
      const socket = new NativeWebSocket(
        `ws://127.0.0.1:${server.port}/drafts/${d.short_id}/socket?expectedUserId=${user.id}&connection=${key}`,
        { headers: { Cookie: "session_token=load-session" } },
      );
      c.socket = socket;
      socket.addEventListener("close", (event) => {
        closes[`${event.code}:${event.reason}`] = (closes[`${event.code}:${event.reason}`] ?? 0) + 1;
        if (c.socket === socket) c.ready = false;
      });
      socket.addEventListener("message", (event) => {
        try {
          const packet = mailDraftDocumentMessageSchema.parse(JSON.parse(String(event.data)));
          if (packet.type === "error") {
            error(packet.payload.code);
            return;
          }
          if (packet.type === "replayReady") {
            c.cursor = packet.payload.cursor;
            c.generation = packet.payload.generation;
            c.ready = true;
            if (c.pending)
              send(c, {
                type: "syncPublish",
                payload: {
                  docId: d.short_id,
                  generation: c.generation,
                  baseCursor: c.pendingBase,
                  payload: toBase64(Y.encodeStateAsUpdate(c.doc)),
                },
              });
            send(c, {
              type: "awarenessPublish",
              payload: {
                docId: d.short_id,
                generation: c.generation,
                payload: toBase64(encodeAwarenessUpdate(c.awareness, [c.doc.clientID])),
              },
            });
          }
          if (packet.type !== "syncPush") return;
          for (const u of packet.payload.updates) {
            Y.applyUpdate(c.doc, fromBase64(u.payload));
            if (u.cursor) c.cursor = u.cursor;
            const pending = d.pending.get(u.payload);
            if (pending?.waiting.delete(c.index)) {
              histogram[Math.min(6000, Math.floor((performance.now() - pending.at) / 10))]!++;
              observations++;
            }
            if (pending?.waiting.size === 0) d.pending.delete(u.payload);
          }
          const visible = c.doc.getText("codemirror").toString();
          for (const [payload, p] of d.pending)
            if (visible.includes(p.marker)) {
              if (p.waiting.delete(c.index)) {
                histogram[Math.min(6000, Math.floor((performance.now() - p.at) / 10))]!++;
                observations++;
              }
              if (!p.waiting.size) d.pending.delete(payload);
            }
          if (packet.payload.snapshot) {
            const snapshot = new Y.Doc();
            try {
              for (const u of packet.payload.updates) Y.applyUpdate(snapshot, fromBase64(u.payload));
              const body = snapshot.getText("codemirror").toString();
              if (c.pending && body.includes(c.pending)) c.pending = null;
            } finally {
              snapshot.destroy();
            }
          }
        } catch {
          error("CLIENT_DECODE");
        }
      });
      await new Promise<void>((done, fail) => {
        const timer = setTimeout(() => {
          socket.terminate();
          fail(new Error("Socket upgrade timeout"));
        }, ackBudgetMs);
        socket.onopen = () => {
          clearTimeout(timer);
          done();
        };
        socket.onerror = () => {
          clearTimeout(timer);
          fail(new Error("Socket upgrade rejected"));
        };
      });
      send(c, { type: "replayRequest", payload: { docId: d.short_id, generation: null, fromCursor: null } });
    };
    const { connectTestNats } = await import("../../../../scripts/fixtures/test-nats");
    const broker = await connectTestNats();
    cleanup.push(() => broker.close());
    const readState = () =>
      within(
        (async () => {
          const [state] = await sql`SELECT
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
            .filter((s) =>
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
    const counters = () => transport.mailDraftConnectionStats();
    inspectSockets = () => ({ open: server.pendingWebSockets, buffers: counters() });
    inspectState = readState;
    const sample = async () => {
      check();
      const memory = process.memoryUsage();
      peakRss = Math.max(peakRss, memory.rss);
      peakHeap = Math.max(peakHeap, memory.heapUsed);
      appendFileSync(
        samples,
        `${JSON.stringify({ at: performance.now(), elapsedMs: started ? performance.now() - started : null, phase: started ? "measuring" : "joining", memory, load: loadavg()[0], sockets: server.pendingWebSockets, buffers: counters(), ...(await readState()) })}\n`,
      );
    };
    initialMemory = process.memoryUsage();
    await sample();
    let sampling = false;
    sampleTimer = setInterval(() => {
      if (sampling) return; // Keep only one statistics read in flight, even during a database stall.
      sampling = true;
      sampled = sample()
        .catch((e) => abort.abort(e))
        .finally(() => {
          sampling = false;
        });
    }, 1000);
    for (const d of drafts.values())
      for (const c of d.clients) {
        check();
        await connect(d, c);
      }
    const deadline = performance.now() + ackBudgetMs;
    while ([...drafts.values()].some((d) => d.clients.some((c) => !c.ready))) {
      check();
      if (performance.now() > deadline) throw new Error("Join timeout");
      await Bun.sleep(50);
    }
    // A raw TCP peer ceases reading after the upgrade. Unlike ignoring message events,
    // pause() actually exercises kernel and server WebSocket backpressure.
    const first = drafts.values().next().value;
    let slow: Socket | undefined;
    if (first) {
      slow = createConnection({ host: "127.0.0.1", port });
      cleanup.push(() => slow?.destroy());
      await new Promise<void>((done, fail) => {
        const timer = setTimeout(() => {
          slow?.destroy();
          fail(new Error("Slow consumer upgrade timeout"));
        }, ackBudgetMs);
        slow?.once("error", (e) => {
          clearTimeout(timer);
          fail(e);
        });
        slow?.once("connect", () =>
          slow?.write(
            `GET /drafts/${first.short_id}/socket?expectedUserId=${user.id} HTTP/1.1\r\nHost: 127.0.0.1:${server.port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: bG9hZC10ZXN0LWNsaWVudA==\r\nSec-WebSocket-Version: 13\r\nCookie: session_token=load-session\r\n\r\n`,
          ),
        );
        slow?.once("data", (data) => {
          clearTimeout(timer);
          if (!data.toString().startsWith("HTTP/1.1 101")) {
            fail(new Error("Slow consumer upgrade failed"));
            return;
          }
          slow?.write(
            maskedFrame(JSON.stringify({ type: "replayRequest", payload: { docId: first.short_id, generation: null, fromCursor: null } })),
          );
          slow?.pause();
          scenarios.slowConsumers++;
          done();
        });
      });
    }
    started = performance.now();
    await sample();
    let reconnectDone = false,
      abruptDone = false,
      requestAbortDone = false;
    while (performance.now() - started < options.seconds * 1000) {
      check();
      const now = performance.now();
      const elapsed = now - started;
      // Graceful reconnect waits for acknowledgement; abrupt disconnect and request abort may interrupt a write.
      if (first) {
        const a = first.clients[0]!,
          b = first.clients[1]!;
        if (!reconnectDone && elapsed > options.seconds * 250 && !a.pending) {
          a.socket?.close(1000, "load reconnect");
          await connect(first, a);
          scenarios.reconnects++;
          reconnectDone = true;
        }
        if (!abruptDone && elapsed > options.seconds * 500) {
          b.socket?.terminate();
          await connect(first, b);
          scenarios.abruptDisconnects++;
          abruptDone = true;
        }
        if (!requestAbortDone && elapsed > options.seconds * 750) {
          scenarios.requestAborts++;
          requestAborts.get(`${first.short_id}-0`)?.abort();
          await connect(first, a);
          requestAbortDone = true;
        }
      }
      for (const d of drafts.values())
        for (const c of d.clients) {
          if (c.pending && now - c.sentAt > ackBudgetMs) throw new Error("Durable acknowledgement timeout");
          if (!c.ready || c.pending || now < c.next) continue;
          const text = c.doc.getText("codemirror");
          const before = Y.encodeStateVector(c.doc);
          const marker = ` [${c.doc.clientID}:${++c.sequence}]`;
          // One small typing burst, with occasional backspace, against the live shared text.
          c.doc.transact(() => {
            if (c.index === 0 && options.burstBytes) {
              text.delete(0, options.burstBytes);
              text.insert(0, String.fromCharCode(97 + (c.sequence % 26)).repeat(options.burstBytes));
            } else if (c.sequence % 4 === 0 && text.length > options.bodyBytes) text.delete(0, 1);
            text.insert(text.length, marker);
          });
          const payload = toBase64(Y.encodeStateAsUpdate(c.doc, before));
          if (d.pending.size >= options.clients * 4) throw new Error("Propagation backlog exceeded generator budget");
          d.pending.set(payload, {
            at: now,
            marker,
            waiting: new Set(d.clients.filter((other) => other !== c && other.ready).map((other) => other.index)),
          });
          c.pending = marker;
          c.pendingBase = c.cursor;
          c.sentAt = now;
          c.next = now + options.intervalMs + c.index * 37;
          send(c, { type: "syncPublish", payload: { docId: d.short_id, generation: c.generation, baseCursor: c.cursor, payload } });
          const position = Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(text, text.length));
          c.awareness.setLocalState({ cursor: { anchor: position, head: position } });
          send(c, {
            type: "awarenessPublish",
            payload: {
              docId: d.short_id,
              generation: c.generation,
              payload: toBase64(encodeAwarenessUpdate(c.awareness, [c.doc.clientID])),
            },
          });
          editCount++;
        }
      await Bun.sleep(20);
    }
    clearInterval(sampleTimer);
    sampleTimer = undefined;
    await sampled;
    const settle = performance.now() + ackBudgetMs;
    while ([...drafts.values()].some((d) => d.clients.some((c) => c.pending || !c.ready))) {
      check();
      if (performance.now() > settle) throw new Error("Final acknowledgement timeout");
      await Bun.sleep(50);
    }
    for (const d of drafts.values()) {
      const persisted = value(
        await within(readDraftDocument({ context, mailboxId, draftId: d.id }), ackBudgetMs, "Final convergence SQL read"),
      );
      for (const c of d.clients)
        if (c.doc.getText("codemirror").toString() !== persisted.durable.content.body) throw new Error("Final document divergence");
      if (d.pending.size) throw new Error("Missing edit propagation");
    }
    if (Object.values(scenarios).some((count) => count === 0)) throw new Error("A disruption scenario did not run");
    ended = performance.now();
    await sample();
    finalState = await readState();
    endMemory = process.memoryUsage();
    slow?.destroy();
    await within(transport.stopMailDraftConnections(), ackBudgetMs, "Socket drain");
    finalSockets = { open: server.pendingWebSockets, buffers: counters() };
    for (const d of drafts.values())
      for (const c of d.clients) {
        c.socket?.terminate();
        c.awareness.destroy();
        c.doc.destroy();
      }
    drafts.clear();
    Bun.gc(true);
    await Bun.sleep(250);
    Bun.gc(true);
    afterGc = process.memoryUsage();
  } catch (e) {
    ended = performance.now();
    failure = e instanceof Error ? e.message : String(e);
    process.exitCode = 1;
  } finally {
    if (sampleTimer) clearInterval(sampleTimer);
    await sampled;
    endMemory ??= process.memoryUsage();
    peakRss = Math.max(peakRss, endMemory.rss);
    peakHeap = Math.max(peakHeap, endMemory.heapUsed);
    try {
      finalState ??= await inspectState?.();
    } catch {
      error("FINAL_STATE");
    }
    const beforeCleanupSockets = inspectSockets?.();
    for (const action of cleanup.reverse())
      try {
        await within(Promise.resolve().then(action), 10_000, "Cleanup step");
      } catch (e) {
        error("CLEANUP");
        failure ??= e instanceof Error ? e.message : "Cleanup failed";
        process.exitCode = 1;
      }
    finalSockets = { beforeCleanup: beforeCleanupSockets, afterCleanup: inspectSockets?.() };
    if (!afterGc) {
      Bun.gc(true);
      afterGc = process.memoryUsage();
    }
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
    const percentile = (p: number) => {
      if (!observations) return null;
      let total = 0;
      for (let i = 0; i < histogram.length; i++) {
        total += histogram[i]!;
        if (total >= observations * p) return (i + 1) * 10;
      }
      return null;
    };
    const summary = {
      options,
      status: failure ? "not-stable" : "passed",
      failure,
      measuredMs: ended ? ended - started : null,
      edits: editCount,
      propagation: { samples: observations, p50Ms: percentile(0.5), p95Ms: percentile(0.95) },
      memory: { initial: initialMemory, peakRss, peakHeap, end: endMemory, afterGc },
      scenarios,
      errors,
      closes,
      finalSockets,
      finalState,
    };
    await writeFile(`${out}/summary.json`, `${JSON.stringify(summary, null, 2)}\n`);
    console.log(JSON.stringify(summary));
    // A driver that failed to close may retain native handles. The evidence names
    // the cleanup failure; the disposable DB/namespace require operator cleanup.
    if (errors.CLEANUP) process.exit(1);
  }
}
