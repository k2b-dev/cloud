import { expect, mock } from "bun:test";
import { createSync, type Sync } from "@k2b/sync";
import { jetstreamManager } from "@nats-io/jetstream";
import * as Y from "yjs";
import { connectTestNats, testFor, testSyncNamespace } from "../../../../scripts/fixtures/test-infra";
import { bindProcessSync, unbindProcessSync } from "../_internal/process-sync";
import {
  SHARED_TEXT_NAME,
  type SharedTextSaveInput,
  type SharedTextSnapshotStore,
  type SharedTextStoredState,
  sharedText,
  sharedTextSnapshotJobConfig,
  toBase64,
} from "./index";

// Every poll, including retry and ordered-partition delivery, has a deadline.
const until = async (check: () => boolean | Promise<boolean>, label: string) => {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(25);
  }
  throw new Error(`Timed out: ${label}`);
};
const encode = (text: string) => {
  const doc = new Y.Doc();
  try {
    doc.getText(SHARED_TEXT_NAME).insert(0, text);
    return Y.encodeStateAsUpdate(doc);
  } finally {
    doc.destroy();
  }
};
const quietLogger = { info() {}, warn() {}, error() {}, debug() {} };

const withFixture = async (run: (fixture: ReturnType<typeof setup>) => Promise<void>) => {
  const connection = await connectTestNats();
  const namespace = testSyncNamespace("shared-text-snapshots");
  const sync = createSync({ connection, namespace, application: "test", defaults: { replicas: 1 } });
  let second: Awaited<ReturnType<typeof connectTestNats>> | undefined;
  let sync2: Sync | undefined;
  let fixture: ReturnType<typeof setup> | undefined;
  try {
    bindProcessSync(sync);
    second = await connectTestNats();
    sync2 = createSync({ connection: second, namespace, application: "test", defaults: { replicas: 1 } });
    fixture = setup(sync, sync2, connection, namespace);
    await run(fixture);
  } finally {
    try {
      if (fixture) await Promise.all(fixture.pipelines.map((pipeline) => pipeline.stop()));
    } finally {
      try {
        await Promise.all([sync.drain(), sync2?.drain()]);
      } finally {
        unbindProcessSync();
        try {
          const manager = await jetstreamManager(connection);
          for await (const stream of manager.streams.list()) {
            if (stream.config.metadata?.["sync.namespace"] === namespace) await manager.streams.delete(stream.config.name);
          }
        } finally {
          await Promise.all([connection.drain(), second?.drain()]);
        }
      }
    }
  }
};

const setup = (sync: Sync, sync2: Sync, connection: Awaited<ReturnType<typeof connectTestNats>>, namespace: string) => {
  const log = sharedText.define({
    id: "test.text",
    retention: { maxAgeMs: 604800000, maxBytes: 1024 * 1024 },
    deadLetterRetention: { maxBytes: 65536 },
    maxPayloadBytes: 4096,
  });
  const config = sharedTextSnapshotJobConfig({ id: "test.snapshots", retention: { maxAgeMs: 604800000, maxBytes: 1024 * 1024 } });
  const states = new Map<string, SharedTextStoredState>();
  const incomplete = new Set<string>();
  const recoveries: string[] = [];
  const loads: { docId: string; revision: string }[] = [];
  const inFlight = new Map<string, number>();
  const maxInFlight = new Map<string, number>();
  const attempts: { docId: string; input: SharedTextSaveInput; accepted: boolean }[] = [];
  const projection = mock((_docId: string, _input: SharedTextSaveInput) => {});
  const hooks: { beforeSave?: (docId: string, input: SharedTextSaveInput) => Promise<void> } = {};
  const store: SharedTextSnapshotStore = {
    list: async ({ limit, after }) =>
      [...states]
        .sort(([a], [b]) => a.localeCompare(b))
        .filter(([id]) => !after || id > after)
        .slice(0, limit)
        .map(([docId, value]) => ({ docId, cursor: value.cursor })),
    load: async (docId) => {
      const stored = states.get(docId);
      if (stored) loads.push({ docId, revision: stored.restoreRevision });
      return stored ? { ...stored } : null;
    },
    save: async (docId, input) => {
      const active = (inFlight.get(docId) ?? 0) + 1;
      inFlight.set(docId, active);
      maxInFlight.set(docId, Math.max(active, maxInFlight.get(docId) ?? 0));
      const attempt = { docId, input, accepted: false };
      attempts.push(attempt);
      try {
        await hooks.beforeSave?.(docId, input);
        // The check and projection form the atomic conditional write. A restore
        // retries unless a newer snapshot already covers this job's cursor.
        const current = states.get(docId);
        if (!current) return;
        if (current.cursor && log.topic().cursorSequence(current.cursor) >= log.topic().cursorSequence(input.cursor)) return;
        if (current.restoreRevision !== input.restoreRevision) throw new Error("Snapshot changed during replay; retry");
        states.set(docId, { state: input.state, text: input.text, cursor: input.cursor, restoreRevision: input.restoreRevision });
        attempt.accepted = true;
        projection(docId, input);
      } finally {
        inFlight.set(docId, (inFlight.get(docId) ?? 1) - 1);
      }
    },
    recover: async (docId, _cause, { signal }) => {
      const initial = states.get(docId);
      if (!initial) return;
      const head = await log.topic().head();
      const doc = new Y.Doc();
      try {
        if (initial.state) Y.applyUpdate(doc, initial.state);
        await log.recover({ docId, after: initial.cursor, until: head, doc, signal });
        await store.save(docId, {
          state: Y.encodeStateAsUpdate(doc),
          text: doc.getText(SHARED_TEXT_NAME).toString(),
          cursor: head,
          restoreRevision: initial.restoreRevision,
          requestedAt: Date.now(),
          actor: null,
          contributors: [],
        });
        incomplete.add(docId);
        recoveries.push(docId);
      } finally {
        doc.destroy();
      }
    },
    advance: async (docId, { from, to, latest }) => {
      const current = states.get(docId);
      if (!current || current.cursor !== from || (latest && log.topic().cursorSequence(latest) > log.topic().cursorSequence(from)))
        return false;
      states.set(docId, { ...current, cursor: to });
      return true;
    },
  };
  const pipelines: ReturnType<typeof sharedText.snapshots>[] = [];
  const pipeline = (instance: Sync) => {
    const value = sharedText.snapshots({
      log: instance === sync ? log : { ...log, topic: () => instance.topic(log.topicConfig) },
      job: () => instance.job(config),
      store,
      logger: quietLogger,
    });
    pipelines.push(value);
    return value;
  };
  const first = pipeline(sync);
  const second = pipeline(sync2);
  const add = (docId: string, text: string | null = null) => {
    states.set(docId, { state: text ? encode(text) : null, cursor: log.topic().cursorAt(0), text, restoreRevision: "0" });
  };
  const publish = (docId: string, update: Uint8Array = encode("update")) =>
    log.topic().publish({ tenantId: docId, data: { kind: "sync", payload: toBase64(update), originNodeId: "test", originPeerId: null } });
  const queue = (worker: typeof first, docId: string, targetCursor: string) => worker.queue({ docId, targetCursor, reason: "unload" });
  return {
    connection,
    namespace,
    sync,
    sync2,
    log,
    config,
    store,
    states,
    incomplete,
    recoveries,
    loads,
    maxInFlight,
    attempts,
    projection,
    hooks,
    pipelines,
    first,
    second,
    add,
    publish,
    queue,
  };
};

testFor("nats")(
  "two snapshot processes serialize one document and eventually cover both producers' updates",
  async () => {
    await withFixture(async (f) => {
      const docId = "shared";
      f.add(docId);
      // Keep save in flight long enough to expose concurrent writes if the
      // broker's ordered consumer stops fencing replicas.
      f.hooks.beforeSave = () => Bun.sleep(50);
      const source = new Y.Doc();
      let last = f.log.topic().cursorAt(0);
      try {
        // Both workers run while updates arrive, so jobs for the same document
        // keep landing on both processes while a save is in flight.
        await Promise.all([f.first.start(), f.second.start()]);
        for (let i = 0; i < 24; i++) {
          const vector = Y.encodeStateVector(source);
          source.getText(SHARED_TEXT_NAME).insert(i, "x");
          const topic = i % 2 === 0 ? f.log.topic() : f.sync2.topic(f.log.topicConfig);
          const receipt = await topic.publish({
            tenantId: docId,
            data: {
              kind: "sync",
              payload: toBase64(Y.encodeStateAsUpdate(source, vector)),
              originNodeId: String(i % 2),
              originPeerId: null,
            },
          });
          last = receipt.cursor;
          await f.queue(i % 2 === 0 ? f.first : f.second, docId, last);
          await Bun.sleep(20);
        }
        await until(() => f.states.get(docId)?.cursor === last, "final snapshot covers the last update");
        await Promise.all([f.first.stop(), f.second.stop()]);
        // Several saves ran, so the serialization was actually exercised.
        expect(f.attempts.length).toBeGreaterThanOrEqual(3);
        expect(f.maxInFlight.get(docId)).toBe(1);
        expect(f.states.get(docId)?.text).toBe("x".repeat(24));
        expect(f.projection).toHaveBeenCalledTimes(f.attempts.filter((attempt) => attempt.accepted).length);
      } finally {
        source.destroy();
      }
    });
  },
  90000,
);

for (const race of ["newer", "restore"] as const)
  testFor("nats")(
    `a snapshot overtaken by ${race} never projects the losing write and settles from current state`,
    async () => {
      await withFixture(async (f) => {
        const docId = race;
        f.add(docId, "OLD");
        const target = await f.publish(docId, encode("LATER"));
        let raced = false;
        f.hooks.beforeSave = async () => {
          if (raced) return;
          raced = true;
          f.states.set(
            docId,
            race === "newer"
              ? { state: encode("NEWER"), text: "NEWER", cursor: target.cursor, restoreRevision: "0" }
              : { state: encode("RESTORED"), text: "RESTORED", cursor: f.log.topic().cursorAt(0), restoreRevision: "1" },
          );
        };
        await f.queue(f.first, docId, target.cursor);
        await f.first.start();
        await until(
          () => raced && (race === "newer" ? f.attempts.length >= 1 : f.projection.mock.calls.length === 1),
          "overtaken snapshot settlement or restore retry",
        );
        await f.first.stop();
        expect(f.attempts[0]?.accepted).toBe(false);
        expect(f.states.get(docId)?.cursor).toBe(target.cursor);
        if (race === "newer") {
          expect(f.states.get(docId)?.text).toBe("NEWER");
          expect(f.projection).not.toHaveBeenCalled();
          expect(f.attempts).toHaveLength(1);
        } else {
          expect(f.attempts.map((attempt) => attempt.input.restoreRevision)).toEqual(["0", "1"]);
          expect(f.states.get(docId)?.text).toContain("RESTORED");
          expect(f.states.get(docId)?.text).toContain("LATER");
          expect(f.states.get(docId)?.text).not.toContain("OLD");
          expect(f.projection).toHaveBeenCalledTimes(1);
          expect(f.projection.mock.calls[0]?.[1].restoreRevision).toBe("1");
        }
        expect(await f.sync.job(f.config).deadLetters.list()).toEqual([]);
        const streams = await Array.fromAsync((await jetstreamManager(f.connection)).streams.list());
        const work = streams.filter(
          (entry) =>
            entry.config.metadata?.["sync.namespace"] === f.namespace &&
            entry.config.metadata?.["sync.id"] === f.config.id &&
            entry.config.subjects.some((subject) => subject.includes(".work")),
        );
        expect(work).toHaveLength(1);
        expect(work[0]?.state.messages).toBe(0);
      });
    },
    90000,
  );

for (const failure of ["gap", "malformed"] as const)
  testFor("nats")(
    `${failure} recovery keeps pending structs/deletes and dead-letters exactly once`,
    async () => {
      await withFixture(async (f) => {
        const docId = failure;
        f.add(docId);
        const source = new Y.Doc();
        const reloaded = new Y.Doc();
        try {
          source.getText(SHARED_TEXT_NAME).insert(0, "MISSING");
          const predecessor = Y.encodeStateAsUpdate(source);
          const vector = Y.encodeStateVector(source);
          source.getText(SHARED_TEXT_NAME).insert(7, " RETAINED");
          source.getText(SHARED_TEXT_NAME).delete(0, 7);
          if (failure === "gap") await f.publish(docId, predecessor);
          else
            await f.log
              .topic()
              .publish({ tenantId: docId, data: { kind: "sync", payload: "not base64!", originNodeId: "test", originPeerId: null } });
          const pending = await f.publish(docId, Y.encodeStateAsUpdate(source, vector));
          // Include another valid, independent retained update after the pending one.
          const last = await f.publish(docId, encode("VALID"));
          if (failure === "gap") {
            const manager = await jetstreamManager(f.connection);
            const stream = (await Array.fromAsync(manager.streams.list())).find(
              (entry) =>
                entry.config.metadata?.["sync.namespace"] === f.namespace &&
                entry.config.metadata?.["sync.id"] === f.log.id &&
                entry.config.subjects.some((subject) => subject.endsWith(".event")),
            );
            if (!stream) throw new Error("Log stream missing");
            await manager.streams.purge(stream.config.name, { seq: pending.streamSequence });
          }
          await f.queue(f.first, docId, last.cursor);
          await f.first.start();
          await until(() => f.recoveries.includes(docId), "history recovery");
          await f.first.stop();
          expect(f.recoveries).toEqual([docId]);
          expect(f.incomplete.has(docId)).toBe(true);
          const stored = f.states.get(docId)!;
          expect(stored.cursor).toBe(last.cursor);
          expect(stored.text).toBe("VALID");
          Y.applyUpdate(reloaded, stored.state!);
          expect(reloaded.store.pendingStructs).not.toBeNull();
          expect(reloaded.store.pendingDs).not.toBeNull();
          Y.applyUpdate(reloaded, predecessor);
          expect(reloaded.getText(SHARED_TEXT_NAME).toString()).toContain(" RETAINED");
          expect(reloaded.getText(SHARED_TEXT_NAME).toString()).toContain("VALID");
          const letters = await f.sync.job(f.config).deadLetters.list();
          expect(letters).toHaveLength(1);
          expect(letters[0]).toMatchObject({
            attempts: 1,
            data: { input: { docId } },
            reason: expect.stringContaining(failure === "gap" ? "Document history is incomplete" : "Retained event cannot be applied"),
          });
        } finally {
          source.destroy();
          reloaded.destroy();
        }
      });
    },
    90000,
  );

testFor("nats")(
  "reconcile queues a stalled document, advances an idle cursor and measures the first unsnapshotted update",
  async () => {
    await withFixture(async (f) => {
      f.add("idle");
      f.add("stalled");
      const first = await f.publish("stalled");
      for (let i = 0; i < 8; i++) await f.publish("other");
      const head = await f.log.topic().head();
      expect(await f.first.reconcile()).toEqual({ checked: 2, queued: 1, advanced: 1 });
      expect(f.states.get("idle")?.cursor).toBe(head);
      const backlog = f.first.backlog();
      expect(backlog?.documents).toBeGreaterThanOrEqual(1);
      expect(backlog?.oldest).toMatchObject({
        docId: "stalled",
        sequence: first.streamSequence,
        sequenceDistance: f.log.topic().cursorSequence(head) - first.streamSequence,
      });
      expect(backlog?.oldest?.ageMs).toBeGreaterThanOrEqual(0);
      await f.first.start();
      await until(() => f.states.get("stalled")?.cursor === head, "reconcile's queued snapshot");
      await f.first.stop();
      await f.first.reconcile();
      expect(f.first.backlog()?.documents).toBe(0);
      expect(f.first.backlog()?.oldest).toBeNull();
    });
  },
  90000,
);
