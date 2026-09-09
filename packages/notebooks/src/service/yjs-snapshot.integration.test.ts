import { expect, spyOn, test } from "bun:test";
import { SQL } from "bun";

const enabled = process.env.NOTEBOOKS_SNAPSHOT_DB_TEST === "1";
const databaseName = process.env.NOTEBOOKS_SNAPSHOT_DB_CHILD;
if (!databaseName) {
  (enabled ? test : test.skip)(
    "snapshot SQL preserves metadata edits and rejects snapshots older than a restore",
    async () => {
      const url = new URL(process.env.DATABASE_URL!);
      if (!["localhost", "127.0.0.1", "ipa_postgres"].includes(url.hostname)) throw new Error("Requires local Postgres");
      const database = `notebook_snapshot_${crypto.randomUUID().replaceAll("-", "")}`;
      const target = new URL(url);
      target.pathname = `/${database}`;
      url.pathname = "/postgres";
      const admin = new SQL(url);
      let created = false;
      try {
        await admin.unsafe(`CREATE DATABASE "${database}"`);
        created = true;
        const child = Bun.spawn([process.execPath, "test", import.meta.path], {
          env: { ...process.env, DATABASE_URL: target.toString(), NOTEBOOKS_SNAPSHOT_DB_CHILD: database },
          stdout: "pipe",
          stderr: "pipe",
        });
        const [stdout, stderr, code] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        expect({ code, output: code === 0 ? "passed" : `${stdout}\n${stderr}` }).toEqual({ code: 0, output: "passed" });
      } finally {
        if (created) await admin.unsafe(`DROP DATABASE "${database}"`);
        await admin.close({ timeout: 5 });
      }
    },
    60_000,
  );
} else {
  test("real note save uses snapshot timestamps and sequence guards", async () => {
    if (!enabled || !/^notebook_snapshot_[a-f0-9]{32}$/.test(databaseName)) throw new Error("Unexpected isolated database");
    const { sql } = await import("bun");
    const [database] = await sql<{ name: string }[]>`SELECT current_database() AS name`;
    expect(database?.name).toBe(databaseName);
    const { createSync } = await import("@k2b/sync");
    const { connect } = await import("@nats-io/transport-node");
    const { bindProcessSync, unbindProcessSync } = await import("@k2b/cloud");
    const connection = await connect({ servers: "nats://127.0.0.1:4222" });
    const namespace = `snapshot-${crypto.randomUUID()}`;
    const sync = createSync({ connection, namespace, application: "notebooks" });
    bindProcessSync(sync);
    try {
      await sql`CREATE SCHEMA auth`.simple();
      await sql`CREATE TABLE auth.users (id UUID PRIMARY KEY)`.simple();
      await sql`CREATE TABLE auth.access (id UUID PRIMARY KEY)`.simple();
      const { migrate } = await import("../migrate");
      await migrate();
      // Only the live invalidation side effect is suppressed. The real note save,
      // restore, version history, activity, and derived-data SQL execute below.
      const workspace = await import("./workspace-events");
      spyOn(workspace, "noteUpdated").mockResolvedValue(undefined);
      const notes = await import("./notes");
      const { createYjsTopic } = await import("./yjs-sync");
      const Y = await import("yjs");
      const encode = (content: string) => {
        const doc = new Y.Doc();
        doc.getText("codemirror").insert(0, content);
        try {
          return Y.encodeStateAsUpdate(doc);
        } finally {
          doc.destroy();
        }
      };
      const notebookId = crypto.randomUUID();
      const noteId = crypto.randomUUID();
      const restoreId = crypto.randomUUID();
      await sql`INSERT INTO notebooks.notebooks(id, short_id, name) VALUES (${notebookId}::uuid, 'testbk', 'Fixture')`;
      for (const [id, shortId] of [
        [noteId, "note01"],
        [restoreId, "note02"],
      ] as const) {
        await sql`INSERT INTO notebooks.notes(id, short_id, notebook_id, title, created_at)
          VALUES (${id}::uuid, ${shortId}, ${notebookId}::uuid, '', '2020-01-01')`;
      }
      // A metadata mutation after snapshot reconstruction started must not drop
      // the first v6 snapshot. Its independent title/position change remains.
      const requestedAt = Date.now() - 60_000;
      await sql`UPDATE notebooks.notes SET position = 42, updated_at = now() WHERE id = ${noteId}::uuid`;
      const cursor = createYjsTopic(noteId).cursorAt(7);
      expect(
        (
          await notes.save({
            noteId,
            streamCursor: cursor,
            requestedAt,
            yjsState: encode("first v6"),
            contentMd: "first v6",
            createdBy: null,
          })
        ).ok,
      ).toBe(true);
      const [saved] = await sql<{ content_md: string; position: number; yjs_stream_cursor: string; seq: string }[]>`
        SELECT content_md, position, yjs_stream_cursor, yjs_stream_seq::text AS seq FROM notebooks.notes WHERE id = ${noteId}::uuid`;
      expect(saved).toEqual({ content_md: "first v6", position: 42, yjs_stream_cursor: cursor, seq: "7" });
      const restoreTopic = createYjsTopic(restoreId);
      const pending = await restoreTopic.publish({
        data: { kind: "sync", payload: Buffer.from(encode("PRE-RESTORE")).toString("base64"), originNodeId: "test", originPeerId: null },
      });
      // A genuine restore changes the Yjs base and must defeat an older worker.
      expect(
        (
          await notes.restoreFromSnapshot({
            noteId: restoreId,
            yjsSnapshot: Buffer.from(encode("restored")).toString("base64"),
            createdBy: null,
          })
        ).ok,
      ).toBe(true);
      expect((await notes.getCurrentWithContent({ id: restoreId }))?.contentMd).toBe("restored");
      const stale = await notes.save({
        noteId: restoreId,
        streamCursor: createYjsTopic(restoreId).cursorAt(1),
        requestedAt,
        yjsState: encode("stale"),
        contentMd: "stale",
        createdBy: null,
      });
      expect(stale.ok).toBe(true);
      const [restored] = await sql<{ content_md: string; yjs_stream_cursor: string | null }[]>`
        SELECT content_md, yjs_stream_cursor FROM notebooks.notes WHERE id = ${restoreId}::uuid`;
      expect(restored).toEqual({ content_md: "restored", yjs_stream_cursor: pending.cursor });
      // Simulate a worker that read the old base before restore, but whose
      // target includes a newer accepted event. Sequence alone cannot fence it.
      const afterRestore = await restoreTopic.publish({
        data: { kind: "sync", payload: Buffer.from(encode("POST")).toString("base64"), originNodeId: "test", originPeerId: null },
      });
      const staleBase = await notes.save({
        noteId: restoreId,
        streamCursor: afterRestore.cursor,
        restoreRevision: "0",
        requestedAt: Date.now(),
        yjsState: encode("stale base"),
        contentMd: "stale base",
        createdBy: null,
      });
      expect(staleBase).toMatchObject({ ok: false, status: 409 });
      expect((await notes.getWithContent({ id: restoreId }))?.contentMd).toBe("restored");
      // A fresh worker using the restored base may persist post-barrier edits.
      const restoredState = await notes.getYjsStateWithCursor({ noteId: restoreId });
      const freshDoc = new Y.Doc();
      try {
        Y.applyUpdate(freshDoc, restoredState!.yjsState!);
        for await (const event of restoreTopic.replay({ after: restoredState!.streamCursor!, until: afterRestore.cursor })) {
          Y.applyUpdate(freshDoc, Buffer.from(event.data.payload, "base64"));
        }
        const freshContent = freshDoc.getText("codemirror").toString();
        expect(freshContent).not.toContain("PRE-RESTORE");
        expect(freshContent).toContain("POST");
        await notes.save({
          noteId: restoreId,
          streamCursor: afterRestore.cursor,
          restoreRevision: restoredState!.restoreRevision,
          requestedAt: Date.now(),
          yjsState: Y.encodeStateAsUpdate(freshDoc),
          contentMd: freshContent,
          createdBy: null,
        });
        expect((await notes.getWithContent({ id: restoreId }))?.contentMd).toBe(freshContent);
      } finally {
        freshDoc.destroy();
      }

      // A worker already holding the pre-restore base must retry its sole job,
      // then rebuild from the restored snapshot and cover the later accepted edit.
      const raceId = crypto.randomUUID();
      await sql`INSERT INTO notebooks.notes(id, short_id, notebook_id, title, created_at)
        VALUES (${raceId}::uuid, 'race01', ${notebookId}::uuid, '', '2020-01-01')`;
      const raceTopic = createYjsTopic(raceId);
      await raceTopic.publish({
        data: { kind: "sync", payload: Buffer.from(encode("OLD")).toString("base64"), originNodeId: "test", originPeerId: null },
      });
      const oldBase = await notes.getYjsStateWithCursor({ noteId: raceId });
      await notes.restoreFromSnapshot({ noteId: raceId, yjsSnapshot: Buffer.from(encode("RESTORED")).toString("base64"), createdBy: null });
      const later = await raceTopic.publish({
        data: { kind: "sync", payload: Buffer.from(encode("LATER")).toString("base64"), originNodeId: "test", originPeerId: null },
      });
      const readState = spyOn(notes, "getYjsStateWithCursor").mockResolvedValueOnce(oldBase);
      const saveCalls = spyOn(notes, "save");
      const { yjsSnapshotWorker } = await import("./yjs-snapshot-worker");
      try {
        await yjsSnapshotWorker.start();
        await yjsSnapshotWorker.queueSnapshotSave({ noteId: raceId, targetCursor: later.cursor, reason: "unload" });
        const deadline = Date.now() + 20_000;
        let persisted = false;
        while (Date.now() < deadline) {
          const [row] = await sql<
            { content_md: string; yjs_stream_cursor: string | null }[]
          >`SELECT content_md, yjs_stream_cursor FROM notebooks.notes WHERE id = ${raceId}::uuid`;
          if (row?.yjs_stream_cursor === later.cursor) {
            expect(row.content_md).toContain("RESTORED");
            expect(row.content_md).toContain("LATER");
            expect(row.content_md).not.toContain("OLD");
            persisted = true;
            break;
          }
          await Bun.sleep(50);
        }
        expect(persisted).toBe(true);
        expect(saveCalls.mock.calls.map(([input]) => input.restoreRevision)).toEqual(["0", "1"]);
      } finally {
        await yjsSnapshotWorker.stop();
        readState.mockRestore();
        saveCalls.mockRestore();
      }

      await notes.save({
        noteId,
        streamCursor: createYjsTopic(noteId).cursorAt(6),
        requestedAt: Date.now(),
        yjsState: encode("older seq"),
        contentMd: "older seq",
        createdBy: null,
      });
      expect((await notes.getWithContent({ id: noteId }))?.contentMd).toBe("first v6");

      // A stored cursor that fell below retention is re-anchored at the head:
      // the stored content stays authoritative, the loss is traced, and the
      // note replays cleanly afterwards instead of gapping forever.
      const { RetentionGapError } = await import("@k2b/sync");
      const { TOPIC_PREFIX } = await import("./yjs-sync");
      const { jetstreamManager } = await import("@nats-io/jetstream");
      const manager = await jetstreamManager(connection);
      const gapId = crypto.randomUUID();
      await sql`INSERT INTO notebooks.notes(id, short_id, notebook_id, title, created_at)
        VALUES (${gapId}::uuid, 'gap001', ${notebookId}::uuid, '', '2020-01-01')`;
      const gapTopic = createYjsTopic(gapId);
      const publishTo = async (topic: ReturnType<typeof createYjsTopic>, content: string) =>
        topic.publish({
          data: { kind: "sync", payload: Buffer.from(encode(content)).toString("base64"), originNodeId: "test", originPeerId: null },
        });
      const gapOne = await publishTo(gapTopic, "GAP-ONE");
      expect(
        (
          await notes.save({
            noteId: gapId,
            streamCursor: gapOne.cursor,
            requestedAt: Date.now(),
            yjsState: encode("GAP-ONE"),
            contentMd: "GAP-ONE",
            createdBy: null,
          })
        ).ok,
      ).toBe(true);
      const gapTwo = await publishTo(gapTopic, "GAP-TWO");
      const gapThree = await publishTo(gapTopic, "GAP-THREE");
      // A topic owns an event stream and a consumer DLQ stream with the same identity.
      const gapStream = (await Array.fromAsync(manager.streams.list())).find(
        (entry) =>
          entry.config.metadata?.["sync.namespace"] === namespace &&
          entry.config.metadata?.["sync.id"] === `${TOPIC_PREFIX}:${gapId}` &&
          entry.config.subjects.some((subject) => subject.endsWith(".event")),
      );
      if (!gapStream) throw new Error("Gap topic stream missing");
      await manager.streams.deleteMessage(gapStream.config.name, gapTwo.streamSequence);
      const gap = await notes.getCurrentWithContent({ id: gapId }).then(
        () => null,
        (error: unknown) => error,
      );
      expect(gap).toBeInstanceOf(RetentionGapError);
      const services = await import("@k2b/cloud/services");
      const traced: unknown[] = [];
      const traceComplete = spyOn(services.trace, "complete").mockImplementation(async (params) => {
        traced.push({ status: params.status, summary: params.summary });
        return { traceId: "t", spanId: "s", traceparent: "00-t-s-01" };
      });
      try {
        expect(await notes.adoptSnapshotAtHead({ noteId: gapId, cause: gap as InstanceType<typeof RetentionGapError> })).toEqual({
          cursor: gapThree.cursor,
        });
      } finally {
        traceComplete.mockRestore();
      }
      expect(traced).toEqual([
        {
          status: "error",
          summary: {
            noteId: gapId,
            storedCursor: gapOne.cursor,
            firstRetainedCursor: gapThree.cursor,
            headCursor: gapThree.cursor,
            recoveredUpdates: 1,
            malformedUpdates: 0,
            historyGaps: 1,
            outcome: "adopted",
          },
        },
      ]);
      const [reanchored] = await sql<{ content_md: string; yjs_stream_cursor: string }[]>`
        SELECT content_md, yjs_stream_cursor FROM notebooks.notes WHERE id = ${gapId}::uuid`;
      expect(reanchored?.yjs_stream_cursor).toBe(gapThree.cursor);
      expect(reanchored?.content_md).toContain("GAP-ONE");
      expect(reanchored?.content_md).toContain("GAP-THREE");
      expect((await notes.getCurrentWithContent({ id: gapId }))?.contentMd).toBe(reanchored?.content_md);

      // The hourly reconcile re-queues only notes whose topic moved past their
      // stored cursor, and the worker then brings them up to date.
      const lagId = crypto.randomUUID();
      await sql`INSERT INTO notebooks.notes(id, short_id, notebook_id, title, created_at)
        VALUES (${lagId}::uuid, 'lag001', ${notebookId}::uuid, '', '2020-01-01')`;
      const lagTopic = createYjsTopic(lagId);
      const lagOne = await publishTo(lagTopic, "LAG-ONE");
      await notes.save({
        noteId: lagId,
        streamCursor: lagOne.cursor,
        requestedAt: Date.now(),
        yjsState: encode("LAG-ONE"),
        contentMd: "LAG-ONE",
        createdBy: null,
      });
      const lagTwo = await publishTo(lagTopic, "LAG-TWO");
      const firstEditId = crypto.randomUUID();
      const blankId = crypto.randomUUID();
      await sql`INSERT INTO notebooks.notes(id, short_id, notebook_id, title)
        VALUES (${firstEditId}::uuid, 'first1', ${notebookId}::uuid, ''), (${blankId}::uuid, 'blank1', ${notebookId}::uuid, '')`;
      const firstEdit = await publishTo(createYjsTopic(firstEditId), "FIRST-EDIT-WITHOUT-ENQUEUE");
      // Stable keyset ordering does not change when snapshot saves update timestamps.
      const firstPage = await notes.listSnapshotCursors({ limit: 2 });
      const secondPage = await notes.listSnapshotCursors({ limit: 5, after: firstPage.at(-1)!.noteId });
      expect(new Set([...firstPage, ...secondPage].map((row) => row.noteId)).size).toBe(7);
      expect([...firstPage, ...secondPage].map((row) => row.noteId)).toEqual([...firstPage, ...secondPage].map((row) => row.noteId).sort());
      const { yjsSnapshotWorker: reconcilingWorker } = await import("./yjs-snapshot-worker");
      expect(await reconcilingWorker.reconcile()).toEqual({ checked: 7, queued: 2 });
      try {
        await reconcilingWorker.start();
        const deadline = Date.now() + 20_000;
        let caughtUp: { content_md: string; yjs_stream_cursor: string | null } | undefined;
        while (Date.now() < deadline) {
          const [row] = await sql<{ content_md: string; yjs_stream_cursor: string | null }[]>`
            SELECT content_md, yjs_stream_cursor FROM notebooks.notes WHERE id = ${lagId}::uuid`;
          if (
            row?.yjs_stream_cursor === lagTwo.cursor &&
            (await notes.getYjsStateWithCursor({ noteId: firstEditId }))?.streamCursor === firstEdit.cursor
          ) {
            caughtUp = row;
            break;
          }
          await Bun.sleep(50);
        }
        expect(caughtUp?.content_md).toContain("LAG-ONE");
        expect(caughtUp?.content_md).toContain("LAG-TWO");
      } finally {
        await reconcilingWorker.stop();
      }
      // First accepted edit survives without any prior saved stream cursor.
      const firstState = await notes.getYjsStateWithCursor({ noteId: firstEditId });
      expect(firstState?.streamCursor).toBe(firstEdit.cursor);
      expect(firstState?.contentMd).toBe("FIRST-EDIT-WITHOUT-ENQUEUE");
      expect((await notes.getYjsStateWithCursor({ noteId: blankId }))?.streamCursor).toBeNull();
      expect(await reconcilingWorker.reconcile()).toEqual({ checked: 7, queued: 0 });

      // Even marker-only recovery invalidates connected readers through the
      // existing workspace event; an unchanged Markdown body is not sufficient.
      const invalidations = spyOn(workspace, "noteUpdated").mockResolvedValue(undefined);
      const unchanged = await notes.getYjsStateWithCursor({ noteId: gapId });
      if (!unchanged?.yjsState) throw new Error("Gap recovery state missing");
      await sql`UPDATE notebooks.notes SET yjs_history_incomplete = FALSE WHERE id = ${gapId}::uuid`;
      invalidations.mockClear();
      await notes.save({
        noteId: gapId,
        yjsState: unchanged.yjsState,
        contentMd: unchanged.contentMd ?? "",
        createdBy: null,
        historyIncomplete: true,
      });
      expect(invalidations.mock.calls.some(([note]) => note.id === gapId)).toBe(true);

      // Malformed bytes must not discard valid edits on either side. Recovery
      // captures one head: an append accepted before recovery returns stays replayable.
      const poisonId = crypto.randomUUID();
      await sql`INSERT INTO notebooks.notes(id, short_id, notebook_id, title)
        VALUES (${poisonId}::uuid, 'pois01', ${notebookId}::uuid, '')`;
      const poisonTopic = createYjsTopic(poisonId);
      const original = encode("ORIGINAL");
      await notes.save({ noteId: poisonId, yjsState: original, contentMd: "ORIGINAL", createdBy: null });
      await publishTo(poisonTopic, "VALID-BEFORE");
      const poison = await poisonTopic.publish({
        data: {
          kind: "sync",
          payload: Buffer.from([255, 255, 255, 255]).toString("base64"),
          originNodeId: "test",
          originPeerId: null,
        },
      });
      const target = await publishTo(poisonTopic, "VALID-AFTER");
      const { MalformedSyncEventError } = await import("./yjs-sync");
      let appended: string | undefined;
      const traceDuringRecovery = spyOn(services.trace, "complete").mockImplementation(async () => {
        appended = (await publishTo(poisonTopic, "CONCURRENT")).cursor;
        return { traceId: "t", spanId: "s", traceparent: "00-t-s-01" };
      });
      try {
        expect(
          await notes.adoptSnapshotAtHead({ noteId: poisonId, cause: new MalformedSyncEventError(poisonId, poison.cursor, "fixture") }),
        ).toEqual({ cursor: target.cursor });
      } finally {
        traceDuringRecovery.mockRestore();
      }
      const recovered = await notes.getYjsStateWithCursor({ noteId: poisonId });
      expect(recovered?.streamCursor).toBe(target.cursor);
      expect(recovered?.historyIncomplete).toBe(true);
      expect(recovered?.contentMd).toContain("ORIGINAL");
      expect(recovered?.contentMd).toContain("VALID-BEFORE");
      expect(recovered?.contentMd).toContain("VALID-AFTER");
      expect(recovered?.contentMd).not.toContain("CONCURRENT");
      expect((await notes.getCurrentWithContent({ id: poisonId }))?.contentMd).toContain("CONCURRENT");
      expect(appended).not.toBe(target.cursor);
      const originals = await sql<{ yjs_snapshot: Buffer; recovery_original: boolean }[]>`
        SELECT yjs_snapshot, recovery_original FROM notebooks.note_versions
        WHERE note_id = ${poisonId}::uuid AND recovery_original = TRUE`;
      expect(originals).toHaveLength(1);
      expect([...originals[0]!.yjs_snapshot]).toEqual([...original]);
      // Protected originals neither expire nor consume the ordinary retention
      // budget. A large recovery history must not evict all recent versions.
      await sql`UPDATE notebooks.note_versions SET created_at = now() - interval '30 minutes' WHERE note_id = ${poisonId}::uuid`;
      await sql`INSERT INTO notebooks.note_versions(note_id, yjs_snapshot, content_md, recovery_original, created_at)
        SELECT ${poisonId}::uuid, ${Buffer.from(original)}, 'ORIGINAL', TRUE, now() - interval '30 minutes' FROM generate_series(1, 100)`;
      await sql`INSERT INTO notebooks.note_versions(note_id, yjs_snapshot, content_md, created_at)
        SELECT ${poisonId}::uuid, ${Buffer.from(original)}, 'ordinary', now() - interval '1 hour' FROM generate_series(1, 10)`;
      await notes.save({
        noteId: poisonId,
        yjsState: encode("NEW VERSION"),
        contentMd: "NEW VERSION",
        createdBy: null,
        createVersion: true,
      });
      const [versionCounts] = await sql<{ protected: number; ordinary: number }[]>`
        SELECT count(*) FILTER (WHERE recovery_original)::int AS protected,
          count(*) FILTER (WHERE NOT recovery_original)::int AS ordinary
        FROM notebooks.note_versions WHERE note_id = ${poisonId}::uuid`;
      expect(versionCounts).toEqual({ protected: 101, ordinary: 11 });

      // A lost delete and an independent editor's later insert can produce a
      // fully integrated yet incomplete document. The visible warning must stay.
      const deleteId = crypto.randomUUID();
      await sql`INSERT INTO notebooks.notes(id, short_id, notebook_id, title)
        VALUES (${deleteId}::uuid, 'del001', ${notebookId}::uuid, '')`;
      const deleteTopic = createYjsTopic(deleteId);
      const writer = new Y.Doc();
      const independent = new Y.Doc();
      try {
        writer.getText("codemirror").insert(0, "KEEP DELETE");
        const base = Y.encodeStateAsUpdate(writer);
        Y.applyUpdate(independent, base);
        const first = await deleteTopic.publish({
          data: { kind: "sync", payload: Buffer.from(base).toString("base64"), originNodeId: "test", originPeerId: null },
        });
        await notes.save({ noteId: deleteId, yjsState: base, contentMd: "KEEP DELETE", streamCursor: first.cursor, createdBy: null });
        writer.getText("codemirror").delete(4, 7);
        const lost = await deleteTopic.publish({
          data: {
            kind: "sync",
            payload: Buffer.from(Y.encodeStateAsUpdate(writer)).toString("base64"),
            originNodeId: "test",
            originPeerId: null,
          },
        });
        const vector = Y.encodeStateVector(independent);
        independent.getText("codemirror").insert(0, "!");
        const retained = await deleteTopic.publish({
          data: {
            kind: "sync",
            payload: Buffer.from(Y.encodeStateAsUpdate(independent, vector)).toString("base64"),
            originNodeId: "test",
            originPeerId: null,
          },
        });
        const owned = (await Array.fromAsync(manager.streams.list())).find(
          (entry) =>
            entry.config.metadata?.["sync.namespace"] === namespace &&
            entry.config.metadata?.["sync.id"] === `${TOPIC_PREFIX}:${deleteId}` &&
            entry.config.subjects.some((subject) => subject.endsWith(".event")),
        );
        if (!owned) throw new Error("Delete fixture topic missing");
        await manager.streams.deleteMessage(owned.config.name, lost.streamSequence);
        await notes.adoptSnapshotAtHead({ noteId: deleteId, cause: new RetentionGapError(first.cursor, retained.cursor, lost.cursor) });
        const partial = await notes.getYjsStateWithCursor({ noteId: deleteId });
        expect(partial?.contentMd).toBe("!KEEP DELETE");
        expect(partial?.historyIncomplete).toBe(true);

        // A restore after recovery reads its base must fence the recovery save.
        const syncModule = await import("./yjs-sync");
        const topicFactory = spyOn(syncModule, "createYjsTopic").mockReturnValue({
          ...deleteTopic,
          head: async () => {
            const head = await deleteTopic.head();
            await sql`UPDATE notebooks.notes SET yjs_restore_revision = yjs_restore_revision + 1,
              yjs_snapshot = ${Buffer.from(encode("RESTORED-DURING-RECOVERY"))}, content_md = 'RESTORED-DURING-RECOVERY',
              yjs_stream_cursor = NULL, yjs_stream_seq = NULL, yjs_snapshot_at = now() WHERE id = ${deleteId}::uuid`;
            return head;
          },
        });
        try {
          await expect(
            notes.adoptSnapshotAtHead({ noteId: deleteId, cause: new RetentionGapError(first.cursor, retained.cursor, lost.cursor) }),
          ).rejects.toThrow("retry from its current state");
        } finally {
          topicFactory.mockRestore();
        }
        expect((await notes.getYjsStateWithCursor({ noteId: deleteId }))?.contentMd).toBe("RESTORED-DURING-RECOVERY");
      } finally {
        writer.destroy();
        independent.destroy();
      }
    } finally {
      await sync.drain();
      unbindProcessSync();
      const { jetstreamManager } = await import("@nats-io/jetstream");
      const manager = await jetstreamManager(connection);
      for await (const stream of manager.streams.list()) {
        if (stream.config.metadata?.["sync.namespace"] === namespace) await manager.streams.delete(stream.config.name);
      }
      await connection.drain();
      await sql.close({ timeout: 5 });
    }
  }, 60_000);
}
