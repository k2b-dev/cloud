import { afterEach, beforeEach, expect, setSystemTime, spyOn, test } from "bun:test";
import {
  type Job,
  type JobContext,
  type JobProcessOptions,
  type JobSubmit,
  RetentionGapError,
  type Topic,
  type TopicEvent,
  type Worker,
} from "@k2b/sync";
import * as Y from "yjs";
import { createDoc } from "./documents";
import { MalformedSharedTextEventError, SHARED_TEXT_NAME, toBase64 } from "./events";
import {
  type SharedTextSnapshotRequest,
  type SharedTextSnapshotStore,
  type SharedTextStoredState,
  type SharedTextSyncEvent,
  sharedText,
  sharedTextSnapshotJobConfig,
} from "./index";

const NOW = new Date("2026-10-19T12:00:00Z");
beforeEach(() => setSystemTime(NOW));
afterEach(() => setSystemTime());
const cursor = (seq: number) => `s6t.fixture.${seq}`;
const sequence = (value: string) => {
  if (!/^s6t\.fixture\.\d+$/.test(value)) throw new Error("Foreign cursor");
  return Number(value.split(".")[2]);
};
const event = (seq: number, docId = "doc", ageMs = 1000): TopicEvent<SharedTextSyncEvent> => {
  const doc = new Y.Doc();
  doc.clientID = seq;
  try {
    doc.getText(SHARED_TEXT_NAME).insert(0, `text${seq}`);
    return {
      cursor: cursor(seq),
      sequence: seq,
      eventId: `event${seq}`,
      tenantId: docId,
      publishedAt: new Date(NOW.getTime() - ageMs),
      data: {
        kind: "sync",
        payload: toBase64(Y.encodeStateAsUpdate(doc)),
        originNodeId: "test",
        originPeerId: null,
        actor: { kind: "user", id: "writer" },
      },
    };
  } finally {
    doc.destroy();
  }
};
const fixture = () => {
  const calls: string[] = [];
  const rows: Array<{ docId: string; cursor: string | null }> = [];
  const states = new Map<string, SharedTextStoredState>();
  states.set("doc", { state: null, cursor: cursor(0), text: null, restoreRevision: "revision" });
  const events = [event(5)];
  const head = { value: cursor(10) };
  const latest = new Map([["doc", cursor(5)]]);
  const loads: string[] = [];
  const saves: Array<Parameters<SharedTextSnapshotStore["save"]>> = [];
  const recoveries: Array<Parameters<SharedTextSnapshotStore["recover"]>> = [];
  const advances: Array<Parameters<SharedTextSnapshotStore["advance"]>> = [];
  const pages: Array<Parameters<SharedTextSnapshotStore["list"]>[0]> = [];
  const replays: Array<NonNullable<Parameters<Topic<SharedTextSyncEvent>["replay"]>[0]>> = [];
  const submitted: JobSubmit<SharedTextSnapshotRequest>[] = [];
  const processors: Array<{
    options: JobProcessOptions<SharedTextSnapshotRequest>;
    handler: (context: JobContext<SharedTextSnapshotRequest>) => Promise<void>;
  }> = [];
  const warnings: unknown[][] = [];
  const infos: unknown[][] = [];
  const lifecycle: unknown[] = [];
  const control: { replayError?: Error; replayHook?: () => Promise<void>; yielded: number; closed: number; firstSequence: number } = {
    yielded: 0,
    closed: 0,
    firstSequence: 1,
  };
  const topic = {
    cursorSequence: sequence,
    cursorAt: cursor,
    head: async () => {
      calls.push("head");
      return head.value;
    },
    latestCursor: async ({ tenantId }: { tenantId?: string } = {}) => {
      calls.push("latest");
      return latest.get(tenantId ?? "") ?? null;
    },
    replay: async function* (options: NonNullable<Parameters<Topic<SharedTextSyncEvent>["replay"]>[0]> = {}) {
      replays.push(options);
      try {
        await control.replayHook?.();
        if (control.replayError) throw control.replayError;
        for (const entry of events) {
          if (
            entry.tenantId !== options.tenantId ||
            entry.sequence <= sequence(options.after ?? cursor(0)) ||
            entry.sequence > sequence(options.until ?? head.value)
          )
            continue;
          control.yielded++;
          yield entry;
        }
      } finally {
        control.closed++;
      }
    },
  };
  const store: SharedTextSnapshotStore = {
    list: async (options) => {
      pages.push(options);
      return rows.filter((row) => !options.after || row.docId > options.after).slice(0, options.limit);
    },
    load: async (docId) => {
      calls.push("load");
      loads.push(docId);
      return states.get(docId) ?? null;
    },
    save: async (...args) => {
      saves.push(args);
    },
    recover: async (...args) => {
      recoveries.push(args);
    },
    advance: async (...args) => {
      advances.push(args);
      return true;
    },
  };
  const worker: Worker = {
    active: 0,
    capacity: 1,
    stop: () => {
      lifecycle.push("stop");
    },
    drain: async (options) => {
      lifecycle.push(options);
    },
    [Symbol.asyncDispose]: async () => {},
  };
  const job: Pick<Job<SharedTextSnapshotRequest>, "process" | "submit"> = {
    submit: async (request) => {
      submitted.push(request);
      return { messageId: "m", streamSequence: 1, duplicate: false, jobId: "j" };
    },
    process: async (options, handler) => {
      processors.push({ options, handler });
      return worker;
    },
  };
  const log = { id: "test.text", topic: () => topic, firstSequence: async () => control.firstSequence };
  const logger = {
    info: (...args: unknown[]) => {
      infos.push(args);
    },
    warn: (...args: unknown[]) => {
      warnings.push(args);
    },
    error() {},
    debug() {},
  };
  const pipeline = sharedText.snapshots({ log, store, job: () => job, logger });
  const context = (signal = new AbortController().signal): JobContext<SharedTextSnapshotRequest> => ({
    jobId: "j",
    key: "doc:5",
    input: { docId: "doc", targetCursor: cursor(5), reason: "unload" },
    attempt: 1,
    failureCount: 0,
    signal,
    heartbeat: async () => {},
    resubmit() {},
  });
  const run = async (ctx = context()) => {
    await pipeline.start();
    return processors[0]!.handler(ctx);
  };
  return {
    pipeline,
    job,
    log,
    store,
    logger,
    run,
    context,
    calls,
    rows,
    states,
    events,
    head,
    latest,
    loads,
    saves,
    recoveries,
    advances,
    pages,
    replays,
    submitted,
    processors,
    warnings,
    infos,
    lifecycle,
    control,
  };
};

test("snapshot job configuration fixes delivery, ordering and retention defaults", () => {
  expect(sharedTextSnapshotJobConfig({ id: "snapshots", retention: { maxAgeMs: 604800000, maxBytes: 1024 } })).toEqual({
    id: "snapshots",
    retention: { maxAgeMs: 604800000, maxBytes: 1024 },
    delivery: { ackWaitMs: 120000, maxAttempts: 20, backoffMs: [5000] },
    ordering: { mode: "partitioned", partitions: 8 },
    terminalRetentionMs: 2592000000,
    deadLetterRetention: { maxBytes: 34603008 },
  });
  expect(
    sharedTextSnapshotJobConfig({
      id: "s",
      retention: { maxAgeMs: 604800000, maxBytes: 1024 },
      terminalRetentionMs: 42,
      deadLetterRetention: { maxBytes: 2048 },
      dedupeWindowMs: 99,
    }),
  ).toMatchObject({ terminalRetentionMs: 42, deadLetterRetention: { maxBytes: 2048 }, dedupeWindowMs: 99 });
});

test("queue coalesces only the same document and sequence; codec preserves application payloads", async () => {
  const f = fixture();
  await f.pipeline.queue({ docId: "doc", targetCursor: cursor(5), reason: "unload" });
  await f.pipeline.queue({ docId: "doc", targetCursor: cursor(6), reason: "unload" });
  expect(f.submitted.map(({ key, coalesce, orderingKey }) => ({ key, coalesce, orderingKey }))).toEqual([
    { key: "doc:5", coalesce: true, orderingKey: "doc" },
    { key: "doc:6", coalesce: true, orderingKey: "doc" },
  ]);
  const inputs: { noteId: string; targetCursor: string; reason: string }[] = [];
  const pipeline = sharedText.snapshots<{ noteId: string; targetCursor: string; reason: string }>({
    ...f,
    job: () => ({
      submit: async (request) => {
        inputs.push(request.input);
        return { messageId: "m", streamSequence: 1, duplicate: false, jobId: "j" };
      },
      process: async (_options, handler) => {
        await handler({ ...f.context(), input: inputs[0]!, resubmit() {} });
        return { active: 0, capacity: 1, stop() {}, drain: async () => {}, [Symbol.asyncDispose]: async () => {} };
      },
    }),
    input: { encode: ({ docId, ...rest }) => ({ noteId: docId, ...rest }), decode: ({ noteId, ...rest }) => ({ docId: noteId, ...rest }) },
  });
  await pipeline.queue({ docId: "doc", targetCursor: cursor(5), reason: "unload" });
  await pipeline.start();
  expect(inputs).toEqual([{ noteId: "doc", targetCursor: cursor(5), reason: "unload" }]);
  expect(f.saves[0]?.[0]).toBe("doc");
  await pipeline.stop();
});

for (const headSeq of [3, 10])
  test(`handler reads load -> head -> latest, saves at max(head ${headSeq}, target 5)`, async () => {
    const f = fixture();
    f.head.value = cursor(headSeq);
    await f.run();
    expect(f.calls).toEqual(["load", "head", "latest"]);
    expect(f.replays).toEqual([{ tenantId: "doc", after: cursor(0), until: cursor(5), signal: expect.any(AbortSignal) }]);
    expect(f.saves).toHaveLength(1);
    expect(f.saves[0]).toEqual([
      "doc",
      {
        state: expect.any(Uint8Array),
        text: "text5",
        cursor: cursor(Math.max(headSeq, 5)),
        restoreRevision: "revision",
        requestedAt: NOW.getTime(),
        actor: null,
        contributors: [{ kind: "user", id: "writer", lastContributedAt: new Date(NOW.getTime() - 1000) }],
      },
    ]);
    await f.pipeline.stop();
  });

test("handler uses read/edit's fixed-client fallback state and last contributor timestamps", async () => {
  const f = fixture();
  const initial = { state: null, cursor: null, text: "fallback", restoreRevision: "r" };
  f.states.set("doc", initial);
  const source = createDoc(initial);
  try {
    const vector = Y.encodeStateVector(source);
    source.getText(SHARED_TEXT_NAME).insert(8, "!");
    f.events[0]!.data.payload = toBase64(Y.encodeStateAsUpdate(source, vector));
    f.events.unshift({ ...event(2), data: { ...event(2).data, payload: toBase64(new Uint8Array([0, 0])) } });
    await f.run();
    expect(f.saves[0]?.[1].text).toBe("fallback!");
    expect(f.saves[0]?.[1].contributors).toHaveLength(1);
  } finally {
    source.destroy();
    await f.pipeline.stop();
  }
});

for (const mode of ["covered", "newer", "missing", "no-events"] as const)
  test(`handler skips ${mode} snapshots`, async () => {
    const f = fixture();
    if (mode === "covered" || mode === "newer") f.states.get("doc")!.cursor = cursor(mode === "covered" ? 5 : 6);
    if (mode === "missing") f.states.delete("doc");
    if (mode === "no-events") f.latest.delete("doc");
    await f.run();
    expect(f.saves).toHaveLength(0);
    expect(f.replays).toHaveLength(0);
    if (mode === "no-events") expect(f.warnings[0]?.[0]).toBe("Snapshot skipped: no retained events for the note");
    await f.pipeline.stop();
  });

test("start is idempotent, process concurrency is one and stop drains with the ack deadline", async () => {
  const f = fixture();
  await Promise.all([f.pipeline.start(), f.pipeline.start()]);
  expect(f.processors).toHaveLength(1);
  expect(f.processors[0]?.options.concurrency).toBe(1);
  await f.pipeline.stop();
  expect(f.lifecycle).toEqual(["stop", { timeoutMs: 120000 }]);
  await f.pipeline.start();
  expect(f.processors).toHaveLength(2);
  await f.pipeline.stop();
});

for (const failure of ["aborted", "heartbeat", "timer-heartbeat", "missing-target"] as const)
  test(`${failure} throws before save and destroys the replay document`, async () => {
    const f = fixture();
    const abort = new AbortController();
    const ctx = f.context(abort.signal);
    const timer = spyOn(globalThis, "setInterval");
    const destroyed = spyOn(Y.Doc.prototype, "destroy");
    const error = new Error(failure);
    if (failure === "aborted")
      f.control.replayHook = async () => {
        abort.abort(error);
      };
    if (failure === "heartbeat" || failure === "timer-heartbeat")
      ctx.heartbeat = async () => {
        throw error;
      };
    if (failure === "timer-heartbeat")
      f.control.replayHook = async () => {
        const tick = timer.mock.calls[0]?.[0];
        expect(timer.mock.calls[0]?.[1]).toBe(15000);
        if (typeof tick !== "function") throw new Error("Missing heartbeat timer");
        tick();
        await Promise.resolve();
      };
    if (failure === "missing-target") f.events.length = 0;
    try {
      await expect(f.run(ctx)).rejects.toThrow(failure === "missing-target" ? "Snapshot replay did not reach its target" : failure);
      expect(f.saves).toHaveLength(0);
      expect(destroyed).toHaveBeenCalledTimes(1);
    } finally {
      timer.mockRestore();
      destroyed.mockRestore();
      await f.pipeline.stop();
    }
  });

for (const error of [
  new RetentionGapError(cursor(0), cursor(5), cursor(4)),
  new MalformedSharedTextEventError("doc", cursor(5), "bad bytes"),
  new Error("transient"),
])
  test(`${error.name} recovery and failure decision`, async () => {
    const f = fixture();
    f.control.replayError = error;
    const ctx = f.context();
    await expect(f.run(ctx)).rejects.toBe(error);
    if (error instanceof RetentionGapError || error instanceof MalformedSharedTextEventError)
      expect(f.recoveries).toEqual([["doc", error, { signal: ctx.signal }]]);
    else expect(f.recoveries).toEqual([]);
    const decision = await f.processors[0]!.options.onError!({ error, context: ctx });
    expect(decision).toEqual(
      error instanceof RetentionGapError
        ? { action: "dead_letter", reason: "Document history is incomplete; retained updates and pending dependencies were recovered" }
        : error instanceof MalformedSharedTextEventError
          ? {
              action: "dead_letter",
              reason: `Retained event cannot be applied; valid updates and pending dependencies were recovered: ${error.message}`,
            }
          : { action: "retry" },
    );
    expect(f.saves).toHaveLength(0);
    await f.pipeline.stop();
  });

test("a malformed retained payload invokes recovery exactly once", async () => {
  const f = fixture();
  f.events[0]!.data.payload = "invalid base64!";
  await expect(f.run()).rejects.toBeInstanceOf(MalformedSharedTextEventError);
  expect(f.recoveries).toHaveLength(1);
  expect(f.saves).toHaveLength(0);
  await f.pipeline.stop();
});

test("reconcile uses 5000-row keyset pages, 26 heartbeats for 5001 documents, and loads legacy/null cursors", async () => {
  const f = fixture();
  f.head.value = cursor(100);
  f.rows.push(
    ...Array.from({ length: 5001 }, (_, i) => ({
      docId: String(i).padStart(5, "0"),
      cursor: i === 5000 ? "s6t.legacy.95" : i === 4999 ? null : i === 0 ? cursor(10) : cursor(90),
    })),
  );
  f.states.set("04999", { state: null, text: null, cursor: null, restoreRevision: "r" });
  f.states.set("05000", { state: null, text: null, cursor: cursor(95), restoreRevision: "r" });
  f.latest.set("05000", cursor(99));
  f.events.push(event(99, "05000"));
  let heartbeats = 0;
  expect(
    await f.pipeline.reconcile({
      heartbeat: async () => {
        heartbeats++;
      },
    }),
  ).toEqual({ checked: 5001, queued: 1, advanced: 1 });
  expect(f.pages).toEqual([
    { limit: 5000, after: undefined, signal: undefined },
    { limit: 5000, after: "04999", signal: undefined },
  ]);
  expect(heartbeats).toBe(26);
  expect(f.loads).toEqual(["04999", "05000"]);
  expect(f.advances).toEqual([["00000", { from: cursor(10), to: cursor(100), latest: null }]]);
  expect(f.submitted[0]?.input).toEqual({ docId: "05000", targetCursor: cursor(99), reason: "reconcile" });
  expect(f.calls.indexOf("head")).toBeLessThan(f.calls.indexOf("latest"));
});

test("reconcile queues an existing document without a stored cursor and skips a missing one", async () => {
  const f = fixture();
  f.head.value = cursor(100);
  f.rows.push({ docId: "fresh", cursor: null }, { docId: "gone", cursor: null }, { docId: "quiet", cursor: null });
  f.states.set("fresh", { state: null, text: "seed", cursor: null, restoreRevision: "r" });
  f.states.set("quiet", { state: null, text: "seed", cursor: null, restoreRevision: "r" });
  f.latest.set("fresh", cursor(42));
  f.latest.set("gone", cursor(43));
  f.events.push(event(42, "fresh"));
  expect(await f.pipeline.reconcile()).toEqual({ checked: 3, queued: 1, advanced: 0 });
  expect(f.submitted.map((entry) => entry.input)).toEqual([{ docId: "fresh", targetCursor: cursor(42), reason: "reconcile" }]);
  expect(f.advances).toEqual([]);
  expect(f.pipeline.backlog()).toMatchObject({ documents: 1, oldest: { docId: "fresh", sequence: 42, sequenceDistance: 58 } });
});

test("reconcile advances only below the older half and honours a store's rejected advance", async () => {
  const f = fixture();
  f.head.value = cursor(100);
  f.control.firstSequence = 20;
  f.rows.push({ docId: "older", cursor: cursor(59) }, { docId: "half", cursor: cursor(60) }, { docId: "recent", cursor: cursor(80) });
  f.store.advance = async (...args) => {
    f.advances.push(args);
    return false;
  };
  expect(await f.pipeline.reconcile()).toEqual({ checked: 3, queued: 0, advanced: 0 });
  expect(f.advances).toEqual([["older", { from: cursor(59), to: cursor(100), latest: null }]]);
});

test("backlog counts stale documents and makes one lookup for the lowest stored sequence, stopping after one event", async () => {
  const f = fixture();
  expect(f.pipeline.backlog()).toBeNull();
  f.rows.push({ docId: "doc", cursor: cursor(0) }, { docId: "behind", cursor: cursor(1) });
  f.latest.set("behind", cursor(8));
  f.latest.set("doc", cursor(6));
  f.events.push(event(6), event(8, "behind", 2000));
  expect(await f.pipeline.reconcile()).toEqual({ checked: 2, queued: 2, advanced: 0 });
  expect(f.pipeline.backlog()).toEqual({
    log: "test.text",
    measuredAt: NOW,
    documents: 2,
    oldest: { docId: "doc", sequence: 5, ageMs: 1000, sequenceDistance: 5 },
  });
  expect(f.replays).toHaveLength(1);
  expect(f.replays[0]).toMatchObject({ tenantId: "doc", after: cursor(0), until: cursor(6) });
  expect(f.control.yielded).toBe(1);
  expect(f.control.closed).toBe(1);
  expect(f.replays[0]?.signal?.aborted).toBe(true);
  expect(f.infos.at(-1)).toEqual(["Shared text snapshot backlog", f.pipeline.backlog()]);
  f.rows.length = 0;
  await f.pipeline.reconcile();
  expect(f.pipeline.backlog()).toEqual({ log: "test.text", measuredAt: NOW, documents: 0, oldest: null });
  expect(f.replays).toHaveLength(1);
});

for (const error of [
  new RetentionGapError(cursor(0), cursor(5)),
  new MalformedSharedTextEventError("doc", cursor(5), "bad"),
  new Error("lookup"),
])
  test(`backlog survives ${error.name} with an explicit unknown age`, async () => {
    const f = fixture();
    f.rows.push({ docId: "doc", cursor: cursor(0) });
    f.control.replayError = error;
    expect(await f.pipeline.reconcile()).toEqual({ checked: 1, queued: 1, advanced: 0 });
    expect(f.pipeline.backlog()?.oldest).toEqual({
      docId: "doc",
      sequence: 1,
      ageMs: null,
      sequenceDistance: 10,
      historyGap: error instanceof RetentionGapError,
    });
    expect(f.warnings).toHaveLength(1);
    expect(f.replays).toHaveLength(1);
  });

for (const phase of ["before", "scan", "lookup"] as const)
  test(`reconcile abort at ${phase} preserves the last backlog report`, async () => {
    const f = fixture();
    await f.pipeline.reconcile();
    const previous = f.pipeline.backlog();
    f.rows.push({ docId: "doc", cursor: cursor(0) });
    const abort = new AbortController();
    const error = new Error("cancelled");
    if (phase === "before") abort.abort(error);
    if (phase === "lookup")
      f.control.replayHook = async () => {
        abort.abort(error);
        expect(f.replays.at(-1)?.signal?.aborted).toBe(true);
        throw error;
      };
    await expect(
      f.pipeline.reconcile({
        signal: abort.signal,
        heartbeat: async () => {
          if (phase === "scan") abort.abort(error);
        },
      }),
    ).rejects.toBe(error);
    expect(f.pipeline.backlog()).toBe(previous);
    expect(f.infos.filter(([message]) => message === "Shared text snapshot backlog")).toHaveLength(1);
  });

test("backlog keeps the lowest stored cursor across pages and uses the final page's head without extra document lookups", async () => {
  const f = fixture();
  f.rows.push(
    ...Array.from({ length: 5001 }, (_, i) => ({ docId: String(i).padStart(5, "0"), cursor: cursor(i === 0 ? 20 : i === 5000 ? 10 : 95) })),
  );
  f.latest.set("00000", cursor(30));
  f.latest.set("05000", cursor(80));
  f.events.push(event(30, "00000"), event(70, "05000", 5000), event(80, "05000"));
  const list = f.store.list;
  f.store.list = async (options) => {
    f.head.value = cursor(options.after ? 200 : 100);
    return list(options);
  };
  expect(await f.pipeline.reconcile()).toEqual({ checked: 5001, queued: 2, advanced: 0 });
  expect(f.pipeline.backlog()?.oldest).toEqual({ docId: "05000", sequence: 70, ageMs: 5000, sequenceDistance: 130 });
  expect(f.calls.filter((call) => call === "head")).toHaveLength(2);
  expect(f.calls.filter((call) => call === "latest")).toHaveLength(5001);
  expect(f.replays).toHaveLength(1);
  expect(f.control.yielded).toBe(1);
});
