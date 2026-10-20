import { expect, spyOn, test } from "bun:test";
import { SQL, sql } from "bun";
import * as Y from "yjs";
import { connectTestNats, requireDatabaseUrl, testFor, testSyncNamespace } from "../../../../scripts/fixtures/test-infra";

const databaseName = process.env.NOTEBOOKS_SNAPSHOT_PROJECTIONS_DB_CHILD;
if (!databaseName) {
  testFor("database", "nats")(
    "snapshots fence overtaken writes and share a binary base with live editors",
    async () => {
      const url = new URL(requireDatabaseUrl());
      const database = `notebook_projection_${crypto.randomUUID().replaceAll("-", "")}_test`;
      const target = new URL(url);
      target.pathname = `/${database}`;
      url.pathname = "/postgres";
      const admin = new SQL(url);
      let created = false;
      try {
        await admin.unsafe(`CREATE DATABASE "${database}"`);
        created = true;
        const child = Bun.spawn([process.execPath, "test", import.meta.path], {
          env: {
            ...process.env,
            DATABASE_URL: target.toString(),
            CLOUD_TEST_DATABASE_URL: target.toString(),
            NOTEBOOKS_SNAPSHOT_PROJECTIONS_DB_CHILD: database,
          },
          stdout: "pipe",
          stderr: "pipe",
          timeout: 50_000,
        });
        const [stdout, stderr, code] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        expect({ code, output: code === 0 ? "passed" : stdout + stderr }).toEqual({ code: 0, output: "passed" });
      } finally {
        if (created) await admin.unsafe(`DROP DATABASE "${database}"`);
        await admin.close({ timeout: 5 });
      }
    },
    60000,
  );
} else {
  test("real snapshot writes fence newer cursors and restore revisions before projecting or recording versions", async () => {
    if (!/^notebook_projection_[a-f0-9]{32}_test$/.test(databaseName)) throw new Error("Unexpected isolated database");
    const [database] = await sql<{ name: string }[]>`SELECT current_database() AS name`;
    expect(database?.name).toBe(databaseName);
    const { createSync } = await import("@k2b/sync");
    const { bindProcessSync, unbindProcessSync } = await import("@k2b/cloud");
    const { jetstreamManager } = await import("@nats-io/jetstream");
    const connection = await connectTestNats();
    const namespace = testSyncNamespace("notebooks-projections");
    const sync = createSync({ connection, namespace, application: "notebooks", defaults: { replicas: 1 } });
    bindProcessSync(sync);
    let invalidations: ReturnType<typeof spyOn> | undefined;
    try {
      await sql`CREATE SCHEMA auth`.simple();
      await sql`CREATE TABLE auth.users (id UUID PRIMARY KEY)`.simple();
      await sql`CREATE TABLE auth.access (id UUID PRIMARY KEY)`.simple();
      // The real worker logs to Core's table in this isolated database too.
      await sql`CREATE SCHEMA logging`.simple();
      await sql`CREATE TABLE logging.entries (
        id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        level TEXT NOT NULL DEFAULT 'info', source TEXT NOT NULL, message TEXT NOT NULL,
        metadata JSONB, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`.simple();
      const { migrate } = await import("../migrate");
      await migrate();
      const workspace = await import("./workspace-events");
      const notify = spyOn(workspace, "noteUpdated").mockResolvedValue(undefined);
      invalidations = notify;
      const notes = await import("./notes");
      const { createYjsTopic } = await import("./yjs-sync");
      const encode = (text: string) => {
        const doc = new Y.Doc();
        try {
          doc.getText("codemirror").insert(0, text);
          return Y.encodeStateAsUpdate(doc);
        } finally {
          doc.destroy();
        }
      };
      const notebookId = crypto.randomUUID();
      await sql`INSERT INTO notebooks.notebooks(id, short_id, name) VALUES (${notebookId}::uuid, 'proj01', 'Projection fixture')`;
      for (const [race, shortId] of [
        ["newer", "newer1"],
        ["restore", "rest01"],
      ] as const) {
        const noteId = crypto.randomUUID();
        await sql`INSERT INTO notebooks.notes(id, short_id, notebook_id, title, created_at)
          VALUES (${noteId}::uuid, ${shortId}, ${notebookId}::uuid, '', '2020-01-01')`;
        const currentCursor = createYjsTopic().cursorAt(20);
        expect(
          await notes.save({
            noteId,
            yjsState: encode("# Current\n\nSaved body"),
            contentMd: "# Current\n\nSaved body",
            createdBy: null,
            createVersion: true,
            streamCursor: currentCursor,
            restoreRevision: "0",
            requestedAt: Date.parse("2026-10-19T12:00:00Z"),
          }),
        ).toMatchObject({ ok: true });
        // Model an intervening restore after a worker captured revision zero.
        // The incoming cursor remains newer, so revision alone must fence it.
        if (race === "restore") await sql`UPDATE notebooks.notes SET yjs_restore_revision = 1 WHERE id = ${noteId}::uuid`;
        await sql`UPDATE notebooks.notes SET data_properties = '{"kept":"yes"}'::jsonb, updated_at = '2026-10-19T12:00:00Z' WHERE id = ${noteId}::uuid`;
        const inspect = async () => {
          const [row] = await sql`
            SELECT content_md, title, data_properties, updated_at::text, yjs_snapshot, yjs_stream_cursor, yjs_restore_revision::text,
              (SELECT count(*)::int FROM notebooks.note_versions WHERE note_id = ${noteId}::uuid) AS versions
            FROM notebooks.notes WHERE id = ${noteId}::uuid`;
          return row;
        };
        const before = await inspect();
        expect(before?.versions).toBe(1);
        notify.mockClear();
        const losing = await notes.save({
          noteId,
          yjsState: encode("# LOSING\n\nDifferent body"),
          contentMd: "# LOSING\n\nDifferent body",
          createdBy: null,
          createVersion: true,
          streamCursor: createYjsTopic().cursorAt(race === "newer" ? 19 : 21),
          restoreRevision: "0",
          requestedAt: Date.parse("2026-10-19T12:01:00Z"),
        });
        expect(losing).toMatchObject(race === "newer" ? { ok: true, data: { versionId: null } } : { ok: false, status: 409 });
        expect(await inspect()).toEqual(before);
        expect(notify).not.toHaveBeenCalled();
      }

      const { yjsSnapshotWorker } = await import("./yjs-snapshot-worker");
      try {
        await yjsSnapshotWorker.start();
        for (const anchored of [false, true]) {
          const noteId = crypto.randomUUID();
          const topic = createYjsTopic();
          const cursor = anchored ? await topic.head() : null;
          // Runtime writers persist the cursor and its numeric fence together.
          const sequence = cursor === null ? null : topic.cursorSequence(cursor);
          await sql`INSERT INTO notebooks.notes(id, short_id, notebook_id, title, content_md, yjs_stream_cursor, yjs_stream_seq, created_at)
            VALUES (${noteId}::uuid, ${anchored ? "seed01" : "seed02"}, ${notebookId}::uuid, '', 'Original', ${cursor}, ${sequence}, '2020-01-01')`;
          const [first, second] = await Promise.all([notes.getAnchoredYjsState({ noteId }), notes.getAnchoredYjsState({ noteId })]);
          // This is the binary state sent by the real socket's initial syncPush.
          // A text-only row must not let the live editor start from an empty doc.
          if (!first?.yjsState || !second?.yjsState || !first.streamCursor)
            throw new Error("Live editor received no binary base or anchored cursor");
          expect(first.yjsState).toEqual(second.yjsState);
          const [coordinates] = await sql<{ cursor: string | null; seq: string | null }[]>`
            SELECT yjs_stream_cursor AS cursor, yjs_stream_seq::text AS seq
            FROM notebooks.notes WHERE id = ${noteId}::uuid`;
          expect(coordinates).toEqual({ cursor: first.streamCursor, seq: String(topic.cursorSequence(first.streamCursor)) });
          const editor = new Y.Doc();
          let saved: ReturnType<typeof spyOn> | undefined;
          try {
            Y.applyUpdate(editor, first.yjsState);
            const text = editor.getText("codemirror");
            expect(text.toString()).toBe("Original");
            expect(Y.decodeStateVector(Y.encodeStateVector(editor)).get(0)).toBe("Original".length);
            const before = Y.encodeStateVector(editor);
            text.insert(text.length, " + live");
            const published = await createYjsTopic().publish({
              tenantId: noteId,
              data: {
                kind: "sync",
                payload: Buffer.from(Y.encodeStateAsUpdate(editor, before)).toString("base64"),
                originNodeId: "test",
                originPeerId: null,
              },
            });
            const snapshotSaved = Promise.withResolvers<Awaited<ReturnType<typeof notes.save>>>();
            const save = notes.save;
            saved = spyOn(notes, "save").mockImplementation(async (params) => {
              const result = await save(params);
              if (params.noteId === noteId && params.streamCursor === published.cursor) snapshotSaved.resolve(result);
              return result;
            });
            await yjsSnapshotWorker.queueSnapshotSave({ noteId, targetCursor: published.cursor, reason: "unload" });
            // Wait for the real save, bounded by the test timeout. A concurrency-1
            // worker may first poll the other seven ordered partitions for 1.5s
            // each; an arbitrary 10s polling deadline races normal delivery.
            expect(await snapshotSaved.promise).toMatchObject({ ok: true });
            const persisted = await notes.getYjsStateWithCursor({ noteId });
            expect(persisted?.streamCursor).toBe(published.cursor);
            expect(persisted?.contentMd).toBe(text.toString());
            expect(
              await notes.editContent({
                noteId,
                createdBy: null,
                data: { operations: [{ kind: "append", content: "AGENT" }] },
              }),
            ).toMatchObject({ ok: true });
            const updated = await notes.getYjsStateWithCursor({ noteId });
            expect(updated?.contentMd).toContain("Original + live");
            expect(updated?.contentMd).toContain("AGENT");
          } finally {
            saved?.mockRestore();
            editor.destroy();
          }
        }
      } finally {
        await yjsSnapshotWorker.stop();
      }
    } finally {
      invalidations?.mockRestore();
      try {
        await sync.drain();
      } finally {
        unbindProcessSync();
        try {
          const manager = await jetstreamManager(connection);
          for await (const stream of manager.streams.list()) {
            if (stream.config.metadata?.["sync.namespace"] === namespace) await manager.streams.delete(stream.config.name);
          }
        } finally {
          await connection.drain();
          await sql.close({ timeout: 5 });
        }
      }
    }
  }, 45000);
}
