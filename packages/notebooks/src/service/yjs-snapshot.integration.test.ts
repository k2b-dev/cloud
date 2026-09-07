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
    const { bindProcessSync, unbindProcessSync } = await import("@valentinkolb/cloud");
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
