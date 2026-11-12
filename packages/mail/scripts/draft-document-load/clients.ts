import { appendFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { loadavg } from "node:os";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { fromBase64, toBase64 } from "@k2b/cloud/shared-text";
import { Awareness, encodeAwarenessUpdate, outdatedTimeout } from "y-protocols/awareness";
import * as Y from "yjs";
import { mailDraftDocumentMessageSchema } from "../../src/lib/draft-document-protocol";
import { draftUpdateId } from "../../src/service/draft-document-diagnostics";
import type { Options } from "../draft-document-load";
import { upgradeComplete } from "./common";

const MiB = 1024 ** 2;
// Match the browser provider: one standard awareness expiry window without acknowledgement.
const ackBudgetMs = outdatedTimeout;
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

const { options, out }: { options: Options; out: string } = await Bun.file(Bun.argv[2]!).json();
const fixture: {
  port: number;
  userId: string;
  drafts: Array<{ id: string; short_id: string; state: string; cursor: string | null; generation: string }>;
} = await Bun.file(`${out}/ready.json`).json();
await writeFile(`${out}/client-pid.json`, JSON.stringify({ pid: process.pid }));
const baseUrl = `http://127.0.0.1:${fixture.port}`,
  port = fixture.port;
const samples = `${out}/client-samples.ndjson`;
const traceWriter = Bun.file(`${out}/client-trace.ndjson`).writer();
let traceBytes = 0;
const trace = (stage: string, fields: Record<string, unknown>) => {
  const line = `${JSON.stringify({ at: performance.timeOrigin + performance.now(), stage, ...fields })}\n`;
  traceBytes += Buffer.byteLength(line);
  if (traceBytes > 64 * MiB) throw new Error("Client trace disk budget exceeded");
  traceWriter.write(line);
};
const loop = monitorEventLoopDelay({ resolution: 10 });
loop.enable();
const cleanup: Array<() => unknown | Promise<unknown>> = [];
const abort = new AbortController();
const interrupt = () => abort.abort(new Error("Interrupted"));
process.on("SIGINT", interrupt);
process.on("SIGTERM", interrupt);
const errors: Record<string, number> = {};
const unexpectedErrors: Record<string, number> = {};
const expectedStops = new WeakSet<NativeSocket>();
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
let afterGc: NodeJS.MemoryUsage | undefined, failure: string | undefined;
let sampleTimer: ReturnType<typeof setInterval> | undefined;
let sampled: Promise<void> = Promise.resolve();

const check = () => {
  abort.signal.throwIfAborted();
  if (unexpectedErrors.BACKPRESSURE) throw new Error("Server admission or buffer budget reached (BACKPRESSURE)");
  const unexpected = Object.keys(unexpectedErrors)[0];
  if (unexpected) throw new Error(`Unexpected client error: ${unexpected}`);
  if ((loadavg()[0] ?? 0) > 40) throw new Error("Host one-minute load exceeds 40");
  if (process.memoryUsage().rss > 512 * MiB) throw new Error("Client RSS budget exceeded");
};

try {
  type Pending = { at: number; marker: string; waiting: Set<number> };
  type Draft = { id: string; short_id: string; pending: Map<string, Pending>; clients: Client[] };
  type Client = {
    index: number;
    peerId: string;
    pendingId: string | null;
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
  for (let i = 0; i < fixture.drafts.length; i++) {
    const source = fixture.drafts[i]!;
    const draft: Draft = { id: source.id, short_id: source.short_id, pending: new Map(), clients: [] };
    drafts.set(draft.short_id, draft);
    for (let j = 0; j < options.clients; j++) {
      const doc = new Y.Doc();
      doc.clientID = 1 + i * options.clients + j;
      Y.applyUpdate(doc, fromBase64(source.state));
      const awareness = new Awareness(doc);
      awareness.setLocalState({ cursor: null });
      draft.clients.push({
        index: j,
        peerId: "",
        pendingId: null,
        doc,
        awareness,
        cursor: source.cursor,
        generation: source.generation,
        ready: false,
        pending: null,
        sentAt: 0,
        pendingBase: null,
        sequence: 0,
        next: 0,
      });
    }
  }
  cleanup.push(() => {
    for (const d of drafts.values())
      for (const c of d.clients) {
        c.socket?.terminate();
        c.awareness.destroy();
        c.doc.destroy();
      }
  });
  const send = (c: Client, packet: import("../../src/lib/draft-document-protocol").MailDraftDocumentRequest) => {
    if (c.socket?.readyState === 1) {
      if (packet.type === "syncPublish") trace("client_send", { updateId: draftUpdateId(packet.payload.payload), peerId: c.peerId });
      c.socket.send(JSON.stringify(packet));
    }
  };
  const connect = async (d: Draft, c: Client) => {
    c.ready = false;
    const key = `${d.short_id}-${c.index}`;
    const socket = new NativeWebSocket(
      `ws://127.0.0.1:${fixture.port}/drafts/${d.short_id}/socket?expectedUserId=${fixture.userId}&connection=${key}`,
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
          const planned = packet.payload.code === "STREAM_FAILED" && expectedStops.has(socket);
          trace("client_error", { peerId: c.peerId, code: packet.payload.code, planned });
          error(packet.payload.code);
          if (!planned) unexpectedErrors[packet.payload.code] = (unexpectedErrors[packet.payload.code] ?? 0) + 1;
          return;
        }
        if (packet.type === "replayReady") {
          c.peerId = packet.payload.peerId;
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
          if (!packet.payload.snapshot)
            trace("peer_apply", { updateId: draftUpdateId(u.payload), peerId: c.peerId, originPeerId: u.originPeerId });
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
            if (c.pending && body.includes(c.pending)) {
              trace("durable_ack", { updateId: c.pendingId, peerId: c.peerId });
              c.pending = null;
              c.pendingId = null;
            }
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

  const sample = async () => {
    check();
    const memory = process.memoryUsage();
    peakRss = Math.max(peakRss, memory.rss);
    peakHeap = Math.max(peakHeap, memory.heapUsed);
    appendFileSync(
      samples,
      `${JSON.stringify({ at: Date.now(), memory, hostLoad: loadavg()[0], eventLoopMs: { mean: loop.mean / 1e6, p95: loop.percentile(95) / 1e6, max: loop.max / 1e6 } })}\n`,
    );
  };
  initialMemory = process.memoryUsage();
  sampleTimer = setInterval(() => {
    sampled = sample().catch((e) => abort.abort(e));
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
          `GET /drafts/${first.short_id}/socket?expectedUserId=${fixture.userId} HTTP/1.1\r\nHost: 127.0.0.1:${fixture.port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: bG9hZC10ZXN0LWNsaWVudA==\r\nSec-WebSocket-Version: 13\r\nCookie: session_token=load-session\r\n\r\n`,
        ),
      );
      let header = "";
      const onData = (data: Buffer) => {
        header += data.toString("latin1");
        try {
          if (!upgradeComplete(header)) return;
        } catch (e) {
          clearTimeout(timer);
          slow?.off("data", onData);
          fail(e);
          return;
        }
        clearTimeout(timer);
        slow?.off("data", onData);
        slow?.write(
          maskedFrame(JSON.stringify({ type: "replayRequest", payload: { docId: first.short_id, generation: null, fromCursor: null } })),
        );
        slow?.pause();
        scenarios.slowConsumers++;
        done();
      };
      slow?.on("data", onData);
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
        trace("scenario", { kind: "graceful", peerId: a.peerId });
        if (a.socket) expectedStops.add(a.socket);
        a.socket?.close(1000, "load reconnect");
        await connect(first, a);
        scenarios.reconnects++;
        reconnectDone = true;
      }
      if (!abruptDone && elapsed > options.seconds * 500) {
        trace("scenario", { kind: "abrupt", peerId: b.peerId });
        if (b.socket) expectedStops.add(b.socket);
        b.socket?.terminate();
        await connect(first, b);
        scenarios.abruptDisconnects++;
        abruptDone = true;
      }
      if (!requestAbortDone && elapsed > options.seconds * 750) {
        trace("scenario", { kind: "request_abort", peerId: a.peerId });
        if (a.socket) expectedStops.add(a.socket);
        scenarios.requestAborts++;
        await fetch(`${baseUrl}/__load/abort?connection=${first.short_id}-0`, { method: "POST" });
        await connect(first, a);
        requestAbortDone = true;
      }
    }
    for (const d of drafts.values())
      for (const c of d.clients) {
        const now = performance.now();
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
        // Reconnects await network/SQL above. Start each edit's clock here,
        // immediately before its send, never at the beginning of that loop.
        const sentAt = performance.now();
        d.pending.set(payload, {
          at: sentAt,
          marker,
          waiting: new Set(d.clients.filter((other) => other !== c && other.ready).map((other) => other.index)),
        });
        c.pendingId = draftUpdateId(payload);
        c.pending = marker;
        c.pendingBase = c.cursor;
        c.sentAt = sentAt;
        c.next = sentAt + options.intervalMs + c.index * 37;
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
  while ([...drafts.values()].some((d) => d.pending.size || d.clients.some((c) => c.pending || !c.ready))) {
    check();
    if (performance.now() > settle) throw new Error("Final acknowledgement timeout");
    await Bun.sleep(50);
  }
  if ([...drafts.values()].some((d) => d.pending.size)) throw new Error("Missing peer propagation");
  const response = await fetch(`${baseUrl}/__load/finish`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(
      [...drafts.values()].map((d) => ({ id: d.id, bodies: d.clients.map((c) => c.doc.getText("codemirror").toString()) })),
    ),
  });
  if (!response.ok) throw new Error(await response.text());
  if (Object.values(scenarios).some((count) => count === 0)) throw new Error("A disruption scenario did not run");

  ended = performance.now();
} catch (e) {
  ended = performance.now();
  failure = e instanceof Error ? e.message : String(e);
} finally {
  if (sampleTimer) clearInterval(sampleTimer);
  await sampled;
  endMemory = process.memoryUsage();
  for (const action of cleanup.reverse()) await action();
  await traceWriter.end();
  Bun.gc(true);
  await Bun.sleep(250);
  Bun.gc(true);
  afterGc = process.memoryUsage();
  loop.disable();
  const percentile = (p: number) => {
    if (!observations) return null;
    let total = 0;
    for (let i = 0; i < histogram.length; i++) {
      total += histogram[i]!;
      if (total >= observations * p) return (i + 1) * 10;
    }
    return null;
  };
  await writeFile(
    `${out}/client-summary.json`,
    JSON.stringify(
      {
        pid: process.pid,
        status: failure ? "not-stable" : "passed",
        failure,
        measuredMs: started ? ended - started : null,
        edits: editCount,
        propagation: { samples: observations, p50Ms: percentile(0.5), p95Ms: percentile(0.95) },
        memory: { initial: initialMemory, peakRss, peakHeap, end: endMemory, afterGc },
        scenarios,
        errors,
        unexpectedErrors,
        closes,
        eventLoopMs: { mean: loop.mean / 1e6, p95: loop.percentile(95) / 1e6, max: loop.max / 1e6 },
      },
      null,
      2,
    ),
  );
  process.exit(failure ? 1 : 0);
}
