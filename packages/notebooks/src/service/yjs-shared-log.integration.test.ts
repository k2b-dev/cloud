import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SQL, sql } from "bun";
import { natsServers, requireDatabaseUrl, testFor } from "../../../../scripts/fixtures/test-infra";

/**
 * The shared Yjs log (#166): one topic for every note keeps the JetStream
 * reservation constant, legacy per-note topics are migrated without losing
 * updates, and cursors stay exact across interleaved notes.
 *
 * Runs in a child process against a fresh `_test` database, like the other
 * snapshot suites, because the notes service binds Bun's default `sql` handle.
 */
const databaseName = process.env.NOTEBOOKS_SHARED_LOG_DB_CHILD;

const docker = async (...args: string[]): Promise<string> => {
  const child = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(`docker ${args[0]} failed: ${err.trim()}`);
  return out.trim();
};

if (!databaseName) {
  testFor("database", "nats")(
    "shared Yjs log: bounded account, legacy migration, cursors",
    async () => {
      const url = new URL(requireDatabaseUrl());
      const database = `notebook_shared_log_${crypto.randomUUID().replaceAll("-", "")}_test`;
      const target = new URL(url);
      target.pathname = `/${database}`;
      url.pathname = "/postgres";
      const admin = new SQL(url);
      // A throwaway broker whose account can reserve 4 GiB: the production
      // shape of #166 at a scale a test can reach.
      const probe = `nats-166-probe-${crypto.randomUUID().slice(0, 8)}`;
      const configDir = await mkdtemp(join(tmpdir(), "nats-166-probe-"));
      let created = false;
      let started = false;
      try {
        await writeFile(
          join(configDir, "nats.conf"),
          [
            "max_payload: 16MB",
            "jetstream { store_dir: /data }",
            "accounts {",
            "  APP: { jetstream: { max_file: 4G, max_mem: 256M }, users: [{ user: app, password: app }] }",
            "}",
          ].join("\n"),
        );
        await docker(
          "run",
          "--detach",
          "--name",
          probe,
          "--publish",
          "127.0.0.1::4222",
          "--volume",
          `${configDir}:/etc/nats:ro`,
          "nats:2.14.3-alpine",
          "--config",
          "/etc/nats/nats.conf",
        );
        started = true;
        const port = (await docker("port", probe, "4222/tcp")).split("\n")[0]!.split(":").at(-1);
        await admin.unsafe(`CREATE DATABASE "${database}"`);
        created = true;
        const child = Bun.spawn([process.execPath, "test", import.meta.path], {
          env: {
            ...process.env,
            DATABASE_URL: target.toString(),
            CLOUD_TEST_DATABASE_URL: target.toString(),
            NOTEBOOKS_SHARED_LOG_DB_CHILD: database,
            NOTEBOOKS_BOUNDED_NATS: `nats://127.0.0.1:${port}`,
          },
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
        if (started) await docker("rm", "--force", "--volumes", probe);
        await rm(configDir, { recursive: true, force: true });
        if (created) await admin.unsafe(`DROP DATABASE "${database}"`);
        await admin.close({ timeout: 5 });
      }
    },
    180_000,
  );
} else {
  const { createSync } = await import("@k2b/sync");
  const { connect } = await import("@nats-io/transport-node");
  const { jetstreamManager } = await import("@nats-io/jetstream");
  const { bindProcessSync, unbindProcessSync } = await import("@k2b/cloud");
  const Y = await import("yjs");

  const encodeText = (content: string) => {
    const doc = new Y.Doc();
    doc.getText("codemirror").insert(0, content);
    try {
      return Y.encodeStateAsUpdate(doc);
    } finally {
      doc.destroy();
    }
  };

  let schemaReady = false;
  const setupSchema = async (): Promise<string> => {
    if (!/^notebook_shared_log_[a-f0-9]{32}_test$/.test(databaseName)) throw new Error("Unexpected isolated database");
    if (!schemaReady) {
      await sql`CREATE SCHEMA auth`.simple();
      await sql`CREATE TABLE auth.users (id UUID PRIMARY KEY)`.simple();
      await sql`CREATE TABLE auth.access (id UUID PRIMARY KEY)`.simple();
      const { migrate } = await import("../migrate");
      await migrate();
      const workspace = await import("./workspace-events");
      const { spyOn } = await import("bun:test");
      spyOn(workspace, "noteUpdated").mockResolvedValue(undefined);
      schemaReady = true;
    }
    const notebookId = crypto.randomUUID();
    await sql`INSERT INTO notebooks.notebooks(id, short_id, name) VALUES (${notebookId}::uuid, ${notebookId.slice(0, 6)}, 'Fixture')`;
    return notebookId;
  };

  let shortIds = 0;
  const insertNote = async (notebookId: string): Promise<string> => {
    const id = crypto.randomUUID();
    shortIds++;
    await sql`INSERT INTO notebooks.notes(id, short_id, notebook_id, title)
      VALUES (${id}::uuid, ${`n${String(shortIds).padStart(5, "0")}`}, ${notebookId}::uuid, '')`;
    return id;
  };

  /** Bind a fresh Sync namespace on `servers` for one scenario; streams are deleted afterwards. */
  const withSync = async (
    servers: string[],
    run: (namespace: string, manager: Awaited<ReturnType<typeof jetstreamManager>>) => Promise<void>,
    auth: { user?: string; pass?: string } = {},
  ): Promise<void> => {
    const connection = await connect({ servers, ignoreClusterUpdates: true, ...auth });
    const namespace = `shared-log-${crypto.randomUUID()}`;
    const sync = createSync({ connection, namespace, application: "notebooks", defaults: { replicas: 1 } });
    bindProcessSync(sync);
    const manager = await jetstreamManager(connection);
    try {
      await run(namespace, manager);
    } finally {
      await sync.drain({ timeoutMs: 5_000 });
      unbindProcessSync();
      for await (const stream of manager.streams.list()) {
        if (stream.config.metadata?.["sync.namespace"] === namespace) await manager.streams.delete(stream.config.name);
      }
      await connection.drain();
    }
  };

  /** What the editor socket does for a note: anchor, catch up, tail, publish one edit. */
  const openAndEdit = async (noteId: string, content: string): Promise<string> => {
    const notes = await import("./notes");
    const { createYjsTopic, NODE_ID, toBase64 } = await import("./yjs-sync");
    const stored = await notes.getAnchoredYjsState({ noteId });
    const topic = createYjsTopic();
    const head = await topic.latestCursor({ tenantId: noteId });
    if (head) for await (const _ of topic.replay({ tenantId: noteId, after: stored!.streamCursor!, until: head })) void _;
    const abort = new AbortController();
    const tail = topic
      .hub({ tenantId: noteId })
      .subscribe({ after: head ?? stored!.streamCursor!, signal: abort.signal })
      [Symbol.asyncIterator]();
    const next = tail.next();
    const published = await topic.publish({
      tenantId: noteId,
      data: { kind: "sync", payload: toBase64(encodeText(content)), originNodeId: NODE_ID, originPeerId: null },
    });
    expect((await next).value?.cursor).toBe(published.cursor);
    abort.abort();
    await tail.return?.();
    return published.cursor;
  };

  test("50 notes open and edit within a JetStream account that per-note topics exhaust", async () => {
    const notebookId = await setupSchema();
    const bounded = process.env.NOTEBOOKS_BOUNDED_NATS!;
    await withSync(
      [bounded],
      async (_namespace, manager) => {
        const noteIds: string[] = [];
        for (let i = 0; i < 50; i++) {
          const noteId = await insertNote(notebookId);
          noteIds.push(noteId);
          await openAndEdit(noteId, `NOTE-${i}`);
        }
        const notes = await import("./notes");
        for (const [i, noteId] of noteIds.entries()) {
          expect((await notes.getCurrentWithContent({ id: noteId }))?.contentMd).toBe(`NOTE-${i}`);
        }
        // The reservation does not grow with notes: one log and its small DLQ.
        const { YJS_LOG_MAX_BYTES, YJS_DEAD_LETTER_MAX_BYTES, legacyYjsTopic } = await import("./yjs-sync");
        let reserved = 0;
        for await (const stream of manager.streams.list()) {
          if (stream.config.metadata?.["sync.id"] === "cloud:notebooks:yjs")
            reserved += stream.config.max_bytes * stream.config.num_replicas;
        }
        expect(reserved).toBe(YJS_LOG_MAX_BYTES + YJS_DEAD_LETTER_MAX_BYTES);

        // The pre-fix shape in the same account: every note reserves two 1 GiB
        // streams, so the remaining ~3 GiB admits one note, not fifty.
        let admitted = 0;
        let failure: unknown = null;
        for (const noteId of noteIds) {
          try {
            await legacyYjsTopic(noteId).ready();
            admitted++;
          } catch (error) {
            failure = error;
            break;
          }
        }
        expect(admitted).toBeLessThan(2);
        expect(String(failure)).toMatch(/insufficient (storage )?resources/i);
        const { isStorageExhausted } = await import("./yjs-sync");
        expect(isStorageExhausted(failure)).toBe(true);
      },
      { user: "app", pass: "app" },
    );
  }, 120_000);

  test("legacy per-note topics are republished, kept while written, and deleted once quiet", async () => {
    const notebookId = await setupSchema();
    await withSync(natsServers(), async (namespace, manager) => {
      const notes = await import("./notes");
      const { legacyYjsTopic, NODE_ID, toBase64, YJS_TOPIC_ID } = await import("./yjs-sync");
      const { migrateLegacyYjsTopics, LEGACY_QUIET_MS } = await import("./yjs-legacy-migration");
      const legacyPublish = (noteId: string, update: Uint8Array) =>
        legacyYjsTopic(noteId).publish({ data: { kind: "sync", payload: toBase64(update), originNodeId: NODE_ID, originPeerId: null } });

      // A note as 0.10 left it: a snapshot at a legacy cursor plus newer,
      // unsnapshotted updates that exist only in its per-note topic.
      const writer = new Y.Doc();
      const text = writer.getText("codemirror");
      const noteId = await insertNote(notebookId);
      text.insert(0, "SNAPSHOTTED");
      const snapshotted = await legacyPublish(noteId, Y.encodeStateAsUpdate(writer));
      await sql`UPDATE notebooks.notes SET yjs_snapshot = ${Buffer.from(Y.encodeStateAsUpdate(writer))},
        content_md = 'SNAPSHOTTED', yjs_stream_cursor = ${snapshotted.cursor}, yjs_stream_seq = ${snapshotted.streamSequence}
        WHERE id = ${noteId}::uuid`;
      let vector = Y.encodeStateVector(writer);
      text.insert(text.length, " PENDING");
      await legacyPublish(noteId, Y.encodeStateAsUpdate(writer, vector));
      // A legacy topic whose note was deleted, and one of a never-edited note.
      const orphan = crypto.randomUUID();
      await legacyPublish(orphan, encodeText("ORPHAN"));
      const blank = await insertNote(notebookId);
      await legacyYjsTopic(blank).ready();

      const listLegacy = async () =>
        (await Array.fromAsync((await import("@k2b/cloud")).getProcessSync().listTopics({ idPrefix: `${YJS_TOPIC_ID}:` })))
          .map((entry) => entry.id)
          .sort();
      expect(await listLegacy()).toEqual([`${YJS_TOPIC_ID}:${blank}`, `${YJS_TOPIC_ID}:${noteId}`, `${YJS_TOPIC_ID}:${orphan}`].sort());

      // Inside the quiet period: updates are captured, nothing is deleted.
      const first = await migrateLegacyYjsTopics();
      expect(first).toMatchObject({ republished: 1, deleted: 1, waiting: 1, failed: 0, remaining: 2 });
      // The never-written topic of the blank note is quiet already and goes.
      expect(await listLegacy()).toEqual([`${YJS_TOPIC_ID}:${noteId}`, `${YJS_TOPIC_ID}:${orphan}`].sort());
      expect((await notes.getCurrentWithContent({ id: noteId }))?.contentMd).toBe("SNAPSHOTTED PENDING");

      // An old-release node keeps writing during the rolling deploy.
      vector = Y.encodeStateVector(writer);
      text.insert(text.length, " LATE");
      await legacyPublish(noteId, Y.encodeStateAsUpdate(writer, vector));
      const later = () => Date.now() + LEGACY_QUIET_MS + 60_000;
      const second = await migrateLegacyYjsTopics({ now: later });
      expect(second).toMatchObject({ deleted: 2, failed: 0, remaining: 0 });
      expect(await listLegacy()).toEqual([]);
      expect((await notes.getCurrentWithContent({ id: noteId }))?.contentMd).toBe("SNAPSHOTTED PENDING LATE");
      const [row] = await sql<{ legacy_seq: string | null; history_incomplete: boolean }[]>`
        SELECT yjs_legacy_seq::text AS legacy_seq, yjs_history_incomplete AS history_incomplete FROM notebooks.notes WHERE id = ${noteId}::uuid`;
      expect(row).toEqual({ legacy_seq: null, history_incomplete: false });
      // No legacy stream (log or DLQ) of this namespace survives.
      const leftovers: string[] = [];
      for await (const stream of manager.streams.list()) {
        const id = stream.config.metadata?.["sync.id"] ?? "";
        if (stream.config.metadata?.["sync.namespace"] === namespace && id.startsWith(`${YJS_TOPIC_ID}:`)) leftovers.push(id);
      }
      expect(leftovers).toEqual([]);

      // A node that is still old recreates the topic after deletion: its
      // updates are captured from sequence 0 again. Re-running is idempotent.
      vector = Y.encodeStateVector(writer);
      text.insert(text.length, " RECREATED");
      await legacyPublish(noteId, Y.encodeStateAsUpdate(writer, vector));
      expect(await migrateLegacyYjsTopics({ now: later })).toMatchObject({ deleted: 1, failed: 0, remaining: 0 });
      expect(await migrateLegacyYjsTopics({ now: later })).toMatchObject({ republished: 0, deleted: 0, remaining: 0 });
      expect((await notes.getCurrentWithContent({ id: noteId }))?.contentMd).toBe("SNAPSHOTTED PENDING LATE RECREATED");
      writer.destroy();
    });
  }, 120_000);

  test("cursors resume exactly across interleaved notes; idle watermarks survive front eviction; real gaps recover", async () => {
    const notebookId = await setupSchema();
    await withSync(natsServers(), async (namespace, manager) => {
      const notes = await import("./notes");
      const { createYjsTopic, replayYjsTopicToCursor } = await import("./yjs-sync");
      const { yjsSnapshotWorker } = await import("./yjs-snapshot-worker");
      const { RetentionGapError } = await import("@k2b/sync");
      const topic = createYjsTopic();
      const [a, b, idle] = [await insertNote(notebookId), await insertNote(notebookId), await insertNote(notebookId)];
      for (const id of [a, b, idle]) await notes.getAnchoredYjsState({ noteId: id });

      // Interleaved edits: each note's replay from its own cursor sees only its updates.
      const writers = new Map([a, b].map((id) => [id, new Y.Doc()]));
      const cursors = new Map<string, string[]>();
      for (let round = 0; round < 4; round++) {
        for (const id of [a, b]) {
          const doc = writers.get(id)!;
          const vector = Y.encodeStateVector(doc);
          doc.getText("codemirror").insert(doc.getText("codemirror").length, `${id.slice(0, 4)}-${round};`);
          const published = await topic.publish({
            tenantId: id,
            data: {
              kind: "sync",
              payload: Buffer.from(Y.encodeStateAsUpdate(doc, vector)).toString("base64"),
              originNodeId: "t",
              originPeerId: null,
            },
          });
          cursors.set(id, [...(cursors.get(id) ?? []), published.cursor]);
        }
      }
      for (const id of [a, b]) {
        const resumed = new Y.Doc();
        const stored = await notes.getYjsStateWithCursor({ noteId: id });
        await replayYjsTopicToCursor({ noteId: id, after: stored!.streamCursor, targetCursor: cursors.get(id)![1]!, doc: resumed });
        expect(resumed.getText("codemirror").toString()).toBe(`${id.slice(0, 4)}-0;${id.slice(0, 4)}-1;`);
        // Resume from the middle cursor: the remaining two updates apply on top.
        await replayYjsTopicToCursor({ noteId: id, after: cursors.get(id)![1]!, targetCursor: cursors.get(id)![3]!, doc: resumed });
        expect(resumed.getText("codemirror").toString()).toBe(writers.get(id)!.getText("codemirror").toString());
        resumed.destroy();
      }

      // Snapshots save a watermark; the idle note's cursor moves to the head in
      // the hourly reconcile, so evicting the front past its old cursor is no gap.
      await yjsSnapshotWorker.start();
      await yjsSnapshotWorker.queueSnapshotSave({ noteId: a, targetCursor: cursors.get(a)![3]!, reason: "unload" });
      const deadline = Date.now() + 20_000;
      while (
        Date.now() < deadline &&
        (await notes.getYjsStateWithCursor({ noteId: a }))?.contentMd !== writers.get(a)!.getText("codemirror").toString()
      ) {
        await Bun.sleep(50);
      }
      await yjsSnapshotWorker.stop();
      expect((await notes.getYjsStateWithCursor({ noteId: a }))?.contentMd).toBe(writers.get(a)!.getText("codemirror").toString());
      const idleBefore = (await notes.getYjsStateWithCursor({ noteId: idle }))!.streamCursor!;
      const reconciled = await yjsSnapshotWorker.reconcile();
      expect(reconciled.advanced).toBeGreaterThan(0);
      const idleAfter = (await notes.getYjsStateWithCursor({ noteId: idle }))!.streamCursor!;
      expect(topic.cursorSequence(idleAfter)).toBeGreaterThan(topic.cursorSequence(idleBefore));

      const log = (await Array.fromAsync(manager.streams.list())).find(
        (entry) =>
          entry.config.metadata?.["sync.namespace"] === namespace &&
          entry.config.metadata?.["sync.id"] === "cloud:notebooks:yjs" &&
          entry.config.subjects.some((s) => s.endsWith(".event")),
      )!;
      // Another editor of note b writes independent content; then the front
      // moves past every older event, including b's unsnapshotted ones.
      const bLate = await topic.publish({
        tenantId: b,
        data: { kind: "sync", payload: Buffer.from(encodeText("b-late;")).toString("base64"), originNodeId: "t", originPeerId: null },
      });
      expect(bLate.streamSequence).toBeGreaterThan(topic.cursorSequence(idleAfter));
      await manager.streams.purge(log.config.name, { seq: bLate.streamSequence });
      const idleEdit = await openAndEdit(idle, "IDLE-EDIT");
      expect((await notes.getCurrentWithContent({ id: idle }))?.contentMd).toBe("IDLE-EDIT");
      expect(topic.cursorSequence(idleEdit)).toBeGreaterThan(topic.cursorSequence(idleAfter));
      expect((await notes.getYjsStateWithCursor({ noteId: idle }))?.historyIncomplete).toBe(false);

      // Note b was never snapshotted: its un-snapshotted updates are gone with the
      // front. Reading reports the gap; recovery falls back to the stored
      // snapshot plus retained updates and marks the history incomplete.
      const gap = await notes.getCurrentWithContent({ id: b }).then(
        () => null,
        (error: unknown) => error,
      );
      expect(gap).toBeInstanceOf(RetentionGapError);
      await notes.adoptSnapshotAtHead({ noteId: b, cause: gap as InstanceType<typeof RetentionGapError> });
      const recovered = await notes.getYjsStateWithCursor({ noteId: b });
      expect(recovered?.historyIncomplete).toBe(true);
      expect(recovered?.contentMd).toContain("b-late;");
      expect((await notes.getCurrentWithContent({ id: b }))?.contentMd).toBe(recovered?.contentMd);
      for (const doc of writers.values()) doc.destroy();
    });
  }, 120_000);
}
