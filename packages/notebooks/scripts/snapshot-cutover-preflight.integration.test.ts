import { expect, test } from "bun:test";
import { createSync } from "@k2b/sync";
import { jetstreamManager } from "@nats-io/jetstream";
import { connect } from "@nats-io/transport-node";
import { SQL } from "bun";

(process.env.NOTEBOOKS_SNAPSHOT_DB_TEST === "1" ? test : test.skip)(
  "cutover preflight reads coverage and old backlog without provisioning resources",
  async () => {
    const url = new URL(process.env.DATABASE_URL!);
    if (!["localhost", "127.0.0.1", "ipa_postgres"].includes(url.hostname)) throw new Error("Requires local Postgres");
    const databaseName = `notebook_cutover_${crypto.randomUUID().replaceAll("-", "")}`;
    const target = new URL(url);
    target.pathname = `/${databaseName}`;
    url.pathname = "/postgres";
    const admin = new SQL(url);
    const database = new SQL(target);
    const connection = await connect({ servers: "nats://127.0.0.1:4222" });
    const namespace = `snapshot-cutover-${crypto.randomUUID()}`;
    const sync = createSync({ connection, namespace, application: "notebooks" });
    const manager = await jetstreamManager(connection);
    let created = false;
    const run = async () => {
      const child = Bun.spawn([process.execPath, new URL("./snapshot-cutover-preflight.ts", import.meta.url).pathname], {
        env: { ...process.env, DATABASE_URL: target.toString(), NATS_SERVERS: "nats://127.0.0.1:4222", SYNC_NAMESPACE: namespace },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      if (stderr) throw new Error(stderr);
      return { code, stdout };
    };
    try {
      await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
      created = true;
      await database`CREATE SCHEMA notebooks`.simple();
      await database`CREATE TABLE notebooks.notes (id uuid PRIMARY KEY, yjs_stream_cursor text, yjs_snapshot bytea)`.simple();
      const noteId = crypto.randomUUID();
      await database`INSERT INTO notebooks.notes (id) VALUES (${noteId}::uuid)`;
      const topic = sync.topic({
        id: `cloud:notebooks:yjs:${noteId}`,
        retention: { maxAgeMs: 7 * 24 * 60 * 60 * 1000, maxBytes: 1024 ** 3 },
      });
      const event = await topic.publish({ data: { kind: "sync", payload: "AAA=" } });
      // Expired history is still a blocker when the DB cursor never covered it.
      for await (const stream of manager.streams.list()) {
        if (stream.config.metadata?.["sync.namespace"] === namespace && stream.state.messages === 1) {
          await manager.streams.deleteMessage(stream.config.name, event.streamSequence);
        }
      }
      const unsaved = await run();
      expect(unsaved.code).toBe(1);
      expect(unsaved.stdout).toContain('"status":"snapshot_required"');
      await database`UPDATE notebooks.notes SET yjs_stream_cursor = ${event.cursor}, yjs_snapshot = ${Buffer.from([0, 0])}`;
      const legacy = sync.job<null>({ id: "notebooks.yjs.snapshot" });
      await legacy.submit({ key: "old-pending", input: null });
      const pending = await run();
      expect(pending.code).toBe(1);
      expect(pending.stdout).toContain('"blocked":true');
      const settled = Promise.withResolvers<void>();
      const worker = await legacy.process({}, async () => {
        settled.resolve();
      });
      await settled.promise;
      await worker.drain();
      const before = (await Array.fromAsync(manager.streams.list()))
        .filter((stream) => stream.config.metadata?.["sync.namespace"] === namespace)
        .map((stream) => stream.config.name)
        .sort();
      const ready = await run();
      expect(ready.code).toBe(0);
      expect(ready.stdout).toContain('"safeToCutOver":true');
      const after = (await Array.fromAsync(manager.streams.list()))
        .filter((stream) => stream.config.metadata?.["sync.namespace"] === namespace)
        .map((stream) => stream.config.name)
        .sort();
      // Account-wide listing pages may repeat a name while independent test
      // namespaces change. Compare resource identities, not page multiplicity.
      expect(new Set(after)).toEqual(new Set(before));
      await database`DELETE FROM notebooks.notes`;
      const deleted = await run();
      expect(deleted.code).toBe(1);
      expect(deleted.stdout).toContain('"status":"deleted_note"');
    } finally {
      await sync.drain();
      for await (const stream of manager.streams.list()) {
        if (stream.config.metadata?.["sync.namespace"] === namespace) await manager.streams.delete(stream.config.name);
      }
      await connection.drain();
      await database.close({ timeout: 5 });
      if (created) await admin.unsafe(`DROP DATABASE "${databaseName}"`);
      await admin.close({ timeout: 5 });
    }
  },
  30_000,
);
