import { connections, sql } from "@k2b/cloud";
import { logger } from "@k2b/cloud/services";
import { createSync, ResourceDriftError } from "@k2b/sync";
import { DiscardPolicy, type JetStreamManager, jetstreamManager } from "@nats-io/jetstream";
import { connect, credsAuthenticator, type NatsConnection } from "@nats-io/transport-node";
import {
  DRAFT_DOCUMENT_COVERAGE_LOCK,
  enableDraftDocumentPruning,
  mailDraftDocumentLog,
  requestDraftDocumentPrune,
  stopDraftDocumentPruning,
} from "./draft-document-log";

const log = logger("mail:draft-document-log-policy");
let migrated = false;
const withManager = async <T>(operation: (manager: JetStreamManager, connection: NatsConnection) => Promise<T>): Promise<T> => {
  const nats = connections().nats;
  const connection = await connect({
    name: "mail-draft-log-policy",
    servers: nats.servers,
    ignoreClusterUpdates: nats.ignoreClusterUpdates,
    ...(nats.creds ? { authenticator: credsAuthenticator(new TextEncoder().encode(nats.creds)) } : {}),
    ...(nats.ca ? { tls: { ca: nats.ca } } : {}),
  });
  try {
    return await operation(await jetstreamManager(connection), connection);
  } finally {
    await connection.close();
  }
};
const findStream = async (manager: JetStreamManager) => {
  for await (const stream of manager.streams.list()) {
    const metadata = stream.config.metadata;
    if (
      metadata?.["sync.namespace"] === connections().nats.namespace &&
      metadata["sync.id"] === mailDraftDocumentLog.id &&
      metadata["sync.kind"] === "topic" &&
      stream.config.subjects.some((subject) => subject.endsWith(".t.*.event"))
    )
      return stream;
  }
  return null;
};

/** Explicit startup migration: never delete/recreate a stream containing SQL cursors. */
export const migrateDraftDocumentLogPolicy = async (): Promise<boolean> => {
  migrated = false;
  await stopDraftDocumentPruning();
  try {
    await withManager(async (manager, connection) => {
      const validation = createSync({
        connection,
        namespace: connections().nats.namespace,
        application: "mail",
        defaults: { replicas: connections().nats.replicas },
      });
      await sql.begin(async (db) => {
        await db`SELECT pg_advisory_xact_lock(${DRAFT_DOCUMENT_COVERAGE_LOCK})`;
        const topic = validation.topic(mailDraftDocumentLog.topicConfig);
        const existing = await findStream(manager);
        if (existing) {
          // A readiness failure is a drift probe, not successful provisioning.
          try {
            await topic.ready();
          } catch (error) {
            if (
              !(error instanceof ResourceDriftError) ||
              error.resource !== existing.config.name ||
              error.differences.some((difference) => difference.field !== "discard" && difference.field !== "max_age")
            )
              throw error;
          }
          const changing = existing.config.discard !== DiscardPolicy.New || existing.config.max_age !== 0;
          if (changing) {
            // Commit the intent on another connection while this transaction
            // holds the exclusive coverage lock. A crash after the broker update
            // must still finish recovery marking before gap tolerance is enabled.
            await sql`INSERT INTO mail.draft_document_log_policy (stream, recovery_pending)
              VALUES (${existing.config.name}, true) ON CONFLICT (stream) DO UPDATE SET recovery_pending = true`;
            await manager.streams.update(existing.config.name, { discard: DiscardPolicy.New, max_age: 0 });
          }
          await topic.ready();
          const [checkpoint] = await db<{ recovery_pending: boolean }[]>`
            SELECT recovery_pending FROM mail.draft_document_log_policy WHERE stream = ${existing.config.name}
          `;
          if (checkpoint?.recovery_pending) {
            const first = (await manager.streams.info(existing.config.name)).state.first_seq;
            let last: string | null = null;
            for (;;) {
              const rows: { id: string; doc_seq: string | null }[] = await db`
                SELECT id, doc_seq FROM mail.drafts
                WHERE state NOT IN ('sent', 'discarded') AND (doc_state IS NOT NULL OR edit_mode = 'shared')
                  AND COALESCE(doc_seq, 0) + 1 < ${first}
                  AND (${last}::uuid IS NULL OR id > ${last}::uuid)
                ORDER BY id LIMIT 200
              `;
              for (const row of rows) {
                const latest = await topic.latestCursor({ tenantId: row.id });
                if (latest && topic.cursorSequence(latest) > Number(row.doc_seq ?? 0))
                  await db`UPDATE mail.drafts SET doc_history_complete = false WHERE id = ${row.id}::uuid`;
              }
              if (rows.length < 200) break;
              last = rows.at(-1)!.id;
            }
            await db`UPDATE mail.draft_document_log_policy SET recovery_pending = false WHERE stream = ${existing.config.name}`;
          }
        } else {
          await topic.ready();
        }
      });
    });
    migrated = true;
    enableDraftDocumentPruning();
    requestDraftDocumentPrune();
    return true;
  } catch (error) {
    log.error("Shared drafts remain unsupported: draft document log policy migration failed", { error });
    return false;
  }
};

/** Read live state, rather than treating a cached ready() promise as a policy check. */
export const sharedDraftsSupported = async (): Promise<boolean> => {
  if (!migrated) return false;
  try {
    return await withManager(async (manager, connection) => {
      const stream = await findStream(manager);
      if (!stream) return false;
      const validation = createSync({
        connection,
        namespace: connections().nats.namespace,
        application: "mail",
        defaults: { replicas: connections().nats.replicas },
      });
      await validation.topic(mailDraftDocumentLog.topicConfig).ready();
      return true;
    });
  } catch (error) {
    log.error("Shared draft log policy could not be verified", { error });
    return false;
  }
};
