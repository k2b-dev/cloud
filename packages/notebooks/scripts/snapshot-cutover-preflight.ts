/** Read-only gate for the quiesced, unpartitioned-to-ordered snapshot cutover. */
import { readFile } from "node:fs/promises";
import { createSync } from "@k2b/sync";
import { jetstreamManager } from "@nats-io/jetstream";
import { connect, credsAuthenticator } from "@nats-io/transport-node";
import { SQL } from "bun";

const LEGACY_JOB_ID = "notebooks.yjs.snapshot";
const NOTE_TOPIC_PREFIX = "cloud:notebooks:yjs:";

type Snapshot = { cursor: string | null; hasSnapshot: boolean };
export const snapshotCoverage = (
  snapshot: Snapshot | null,
  lastSequence: number,
  sequenceOf: (cursor: string) => number,
): "covered" | "snapshot_required" | "deleted_note" | "invalid_cursor" => {
  if (!snapshot) return "deleted_note";
  if (lastSequence === 0 && snapshot.cursor === null) return "covered";
  if (!snapshot.cursor || !snapshot.hasSnapshot) return "snapshot_required";
  try {
    // Greater is also unsafe: the broker may have been recreated behind the DB.
    return sequenceOf(snapshot.cursor) === lastSequence ? "covered" : "snapshot_required";
  } catch {
    return "invalid_cursor";
  }
};

export const main = async (): Promise<void> => {
  const namespace = process.env.SYNC_NAMESPACE?.trim();
  const servers = process.env.NATS_SERVERS?.split(",")
    .map((server) => server.trim())
    .filter(Boolean);
  const databaseUrl = process.env.DATABASE_URL;
  if (!namespace || !servers?.length || !databaseUrl)
    throw new Error("Set SYNC_NAMESPACE, NATS_SERVERS, and DATABASE_URL for the exact installation");
  const credsFile = process.env.NATS_CREDS_FILE;
  const caFile = process.env.NATS_TLS_CA_FILE;
  const connection = await connect({
    servers,
    name: "notebooks-snapshot-cutover-preflight",
    ignoreClusterUpdates: process.env.NATS_IGNORE_CLUSTER_UPDATES === "true",
    ...(credsFile ? { authenticator: credsAuthenticator(await readFile(credsFile)) } : {}),
    ...(caFile ? { tls: { caFile } } : {}),
  });
  const database = new SQL(databaseUrl);
  // Declaration-only topic handles validate opaque cursors. Never call ready(),
  // publish(), process(), or any API that provisions a resource in this command.
  const sync = createSync({ connection, namespace, application: "notebooks" });
  let blockers = 0;
  let topics = 0;
  const inspectedNotes = new Set<string>();
  let legacyResources = 0;
  try {
    const manager = await jetstreamManager(connection);
    for await (const stream of manager.streams.list()) {
      const metadata = stream.config.metadata;
      if (metadata?.["sync.namespace"] !== namespace) continue;
      const id = metadata["sync.id"];
      if (!id || (id !== LEGACY_JOB_ID && !id.startsWith(NOTE_TOPIC_PREFIX))) continue;
      if (metadata["sync.managed"] !== "true" || metadata["sync.owner"] !== "notebooks" || metadata["sync.api"] !== "6") {
        console.log(JSON.stringify({ type: "unexpected_resource", stream: stream.config.name, id }));
        blockers++;
        continue;
      }
      if (id === LEGACY_JOB_ID) {
        legacyResources++;
        // Claims and the old mutex are retained for recovery; historical KV
        // revisions are not pending work. Work and dead-letter streams must empty.
        const coordination = stream.config.name.startsWith("KV_");
        let pending = 0;
        let ackPending = 0;
        if (!coordination) {
          for await (const consumer of manager.consumers.list(stream.config.name)) {
            pending += consumer.num_pending;
            ackPending += consumer.num_ack_pending;
          }
        }
        const blocked = !coordination && (stream.state.messages > 0 || pending > 0 || ackPending > 0);
        if (blocked) blockers++;
        console.log(
          JSON.stringify({
            type: "legacy_resource",
            stream: stream.config.name,
            kind: metadata["sync.kind"],
            coordination,
            messages: stream.state.messages,
            pending,
            ackPending,
            blocked,
          }),
        );
        continue;
      }
      // Each Sync topic also owns a DLQ stream. Only the event stream defines
      // the document's high-water sequence; its metadata is checked above.
      if (metadata["sync.kind"] !== "topic" || !stream.config.subjects?.some((subject) => subject.endsWith(".t.*.event"))) continue;
      const noteId = id.slice(NOTE_TOPIC_PREFIX.length);
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(noteId)) {
        console.log(JSON.stringify({ type: "invalid_note_resource", stream: stream.config.name, id }));
        blockers++;
        continue;
      }
      inspectedNotes.add(noteId);
      const [row] = await database<{ cursor: string | null; has_snapshot: boolean }[]>`
        SELECT yjs_stream_cursor AS cursor, yjs_snapshot IS NOT NULL AS has_snapshot
        FROM notebooks.notes WHERE id = ${noteId}::uuid`;
      const topic = sync.topic({ id, retention: { maxAgeMs: 7 * 24 * 60 * 60 * 1000, maxBytes: 1024 ** 3 } });
      const status = snapshotCoverage(
        row ? { cursor: row.cursor, hasSnapshot: row.has_snapshot } : null,
        stream.state.last_seq,
        topic.cursorSequence,
      );
      topics++;
      if (status !== "covered") blockers++;
      console.log(
        JSON.stringify({
          type: "note_snapshot",
          noteId,
          stream: stream.config.name,
          retainedEvents: stream.state.messages,
          lastSequence: stream.state.last_seq,
          cursor: row?.cursor ?? null,
          status,
        }),
      );
    }
    // A restored/saved note must not silently point to a missing topic or a
    // different namespace. No archive/lock filter: every existing note counts.
    let afterId: string | null = null;
    while (true) {
      const rows: Array<{ id: string }> = await database`
        SELECT id FROM notebooks.notes WHERE yjs_stream_cursor IS NOT NULL
          AND (${afterId}::uuid IS NULL OR id > ${afterId}::uuid)
        ORDER BY id LIMIT 200`;
      for (const row of rows) {
        if (inspectedNotes.has(row.id)) continue;
        blockers++;
        console.log(JSON.stringify({ type: "missing_note_topic", noteId: row.id }));
      }
      const last = rows.at(-1);
      if (!last) break;
      afterId = last.id;
    }
    console.log(
      JSON.stringify({
        type: "summary",
        namespace,
        topics,
        legacyResources,
        blockers,
        safeToCutOver: blockers === 0,
        requiresQuiescedWriters: true,
      }),
    );
    if (blockers > 0) process.exitCode = 1;
  } finally {
    await sync.drain();
    await database.close({ timeout: 5 });
    await connection.drain();
  }
};

if (import.meta.main) await main();
