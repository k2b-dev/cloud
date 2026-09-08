import { expect, spyOn, test } from "bun:test";
import { createSync, RetentionGapError } from "@k2b/sync";
import { connect } from "@nats-io/transport-node";
import { bindProcessSync, unbindProcessSync } from "@valentinkolb/cloud";
import * as Y from "yjs";
import { createYjsTopic, MalformedSyncEventError, NODE_ID, replayYjsTopicToCursor, toBase64 } from "./yjs-sync";

const enabled = process.env.NOTEBOOKS_NATS_TEST === "1";
(enabled ? test : test.skip)(
  "Yjs replay uses a finite head, rejects retention gaps and preserves subsequent edits",
  async () => {
    const connection = await connect({ servers: "nats://127.0.0.1:4222" });
    const namespace = `notebook-test-${crypto.randomUUID()}`;
    const sync = createSync({ connection, namespace, application: "notebooks" });
    bindProcessSync(sync);
    const noteId = crypto.randomUUID();
    const source = new Y.Doc();
    const replayed = new Y.Doc();
    try {
      const topic = createYjsTopic(noteId);
      await sync.ready();
      source.getText("codemirror").insert(0, "first");
      const first = await topic.publish({
        data: { kind: "sync", payload: toBase64(Y.encodeStateAsUpdate(source)), originNodeId: NODE_ID, originPeerId: null },
      });
      const state = Y.encodeStateVector(source);
      source.getText("codemirror").insert(5, " second");
      const second = await topic.publish({
        data: { kind: "sync", payload: toBase64(Y.encodeStateAsUpdate(source, state)), originNodeId: NODE_ID, originPeerId: null },
      });
      await replayYjsTopicToCursor({ noteId, after: null, targetCursor: first.cursor, doc: replayed });
      expect(replayed.getText("codemirror").toString()).toBe("first");
      await replayYjsTopicToCursor({ noteId, after: first.cursor, targetCursor: second.cursor, doc: replayed });
      expect(replayed.getText("codemirror").toString()).toBe("first second");
      expect(topic.cursorSequence(second.cursor)).toBe(second.streamSequence);

      // Remove the first retained update only in this test namespace: a document
      // without a covering DB snapshot must fail instead of reconstructing a suffix.
      const { jetstreamManager } = await import("@nats-io/jetstream");
      const manager = await jetstreamManager(connection);
      const streams = await Array.fromAsync(manager.streams.list());
      const stream = streams.find(
        (entry) =>
          entry.config.metadata?.["sync.namespace"] === namespace &&
          entry.config.metadata?.["sync.kind"] === "topic" &&
          entry.state.messages === 2,
      );
      expect(stream).toBeDefined();
      if (!stream) throw new Error("Test topic stream missing");
      await manager.streams.deleteMessage(stream.config.name, first.streamSequence);
      const incomplete = new Y.Doc();
      try {
        await expect(replayYjsTopicToCursor({ noteId, after: null, targetCursor: second.cursor, doc: incomplete })).rejects.toBeInstanceOf(
          RetentionGapError,
        );
      } finally {
        incomplete.destroy();
      }

      // Exercise the real durable snapshot worker against the retained gap. Only
      // the database seam is stubbed, so no application note is created or changed.
      const notes = await import("./notes");
      const { SNAPSHOT_JOB_CONFIG, yjsSnapshotWorker } = await import("./yjs-snapshot-worker");
      const readState = spyOn(notes, "getYjsStateWithCursor").mockResolvedValue({
        yjsState: null,
        streamCursor: null,
        restoreRevision: "0",
        contentMd: null,
        historyIncomplete: false,
      });
      const save = spyOn(notes, "save").mockResolvedValue({ ok: true, data: undefined });
      const adopt = spyOn(notes, "adoptSnapshotAtHead").mockResolvedValue({ cursor: second.cursor });
      try {
        await yjsSnapshotWorker.start();
        await yjsSnapshotWorker.queueSnapshotSave({ noteId, targetCursor: second.cursor, reason: "unload" });
        // One handler slot rotates across eight partition consumers while idle (1.5 s polls each).
        const deadline = Date.now() + 25_000;
        while (readState.mock.calls.length === 0 && Date.now() < deadline) await Bun.sleep(10);
        expect(readState).toHaveBeenCalled();
        await yjsSnapshotWorker.stop();
        expect(save).not.toHaveBeenCalled();
        // The gap is terminal: the stored snapshot is re-anchored once and the
        // job is dead-lettered as the durable record, on the first attempt.
        expect(adopt).toHaveBeenCalledTimes(1);
        expect(adopt.mock.calls[0]?.[0]).toMatchObject({ noteId, cause: expect.any(RetentionGapError) });
        const failures = await sync.job(SNAPSHOT_JOB_CONFIG).deadLetters.list();
        expect(failures).toHaveLength(1);
        expect(failures[0]?.reason).toContain("Document history is incomplete");
        expect(readState).toHaveBeenCalledTimes(1);
        // Distinct target cursors stay separately queued. The failed target can
        // be submitted again after its prior coalescing claim was released.
        await yjsSnapshotWorker.queueSnapshotSave({ noteId, targetCursor: second.cursor, reason: "unload" });
        await yjsSnapshotWorker.queueSnapshotSave({ noteId, targetCursor: first.cursor, reason: "unload" });
        const pending = (await Array.fromAsync(manager.streams.list())).filter(
          (entry) =>
            entry.config.metadata?.["sync.namespace"] === namespace &&
            entry.config.metadata?.["sync.id"] === "notebooks.yjs.snapshot.ordered" &&
            entry.state.messages === 2,
        );
        expect(pending.length).toBeGreaterThan(0);

        // A retained event that is not a Yjs update can never be replayed: the
        // stored snapshot is re-anchored at the head (so the reconciler stops
        // re-queueing the note) and the job dead-letters on the first attempt.
        const poisonedId = crypto.randomUUID();
        adopt.mockClear();
        await createYjsTopic(poisonedId).publish({
          data: { kind: "sync", payload: toBase64(new Uint8Array([255, 255, 255, 255])), originNodeId: NODE_ID, originPeerId: null },
        });
        readState.mockClear();
        await yjsSnapshotWorker.start();
        await yjsSnapshotWorker.queueSnapshotSave({
          noteId: poisonedId,
          targetCursor: createYjsTopic(poisonedId).cursorAt(1),
          reason: "unload",
        });
        const poisonDeadline = Date.now() + 25_000;
        while (Date.now() < poisonDeadline) {
          const letters = await sync.job(SNAPSHOT_JOB_CONFIG).deadLetters.list();
          if (letters.some((letter) => letter.data.key.startsWith(`${poisonedId}:`))) break;
          await Bun.sleep(25);
        }
        await yjsSnapshotWorker.stop();
        const poisoned = (await sync.job(SNAPSHOT_JOB_CONFIG).deadLetters.list()).filter((letter) =>
          letter.data.key.startsWith(`${poisonedId}:`),
        );
        expect(poisoned).toHaveLength(1);
        expect(poisoned[0]).toMatchObject({ attempts: 1, reason: expect.stringContaining("Retained event cannot be applied") });
        // The two re-submitted jobs of the first note may run in the same window; judge the poisoned note alone.
        expect(readState.mock.calls.filter(([input]) => input.noteId === poisonedId)).toHaveLength(1);
        expect(save).not.toHaveBeenCalled();
        expect(adopt.mock.calls.filter(([input]) => input.noteId === poisonedId)).toEqual([
          [{ noteId: poisonedId, cause: expect.any(MalformedSyncEventError), signal: expect.any(AbortSignal) }],
        ]);
      } finally {
        await yjsSnapshotWorker.stop();
        readState.mockRestore();
        save.mockRestore();
        adopt.mockRestore();
      }
      // A fully saved idle document remains joinable after every retained update
      // expires. Its saved cursor still covers that history; zero does not.
      await manager.streams.deleteMessage(stream.config.name, second.streamSequence);
      expect(await topic.latestCursor()).toBeNull();
      const idleAbort = new AbortController();
      const idleSubscription = topic.hub().subscribe({ after: second.cursor, signal: idleAbort.signal })[Symbol.asyncIterator]();
      const nextLive = idleSubscription.next();
      const third = await topic.publish({
        data: { kind: "sync", payload: toBase64(Y.encodeStateAsUpdate(source)), originNodeId: NODE_ID, originPeerId: null },
      });
      expect((await nextLive).value?.cursor).toBe(third.cursor);
      idleAbort.abort();
      await idleSubscription.return?.();
    } finally {
      source.destroy();
      replayed.destroy();
      await sync.drain();
      unbindProcessSync();
      const { jetstreamManager } = await import("@nats-io/jetstream");
      const manager = await jetstreamManager(connection);
      for await (const stream of manager.streams.list()) {
        if (stream.config.metadata?.["sync.namespace"] === namespace) await manager.streams.delete(stream.config.name);
      }
      await connection.drain();
    }
  },
  90_000,
);
