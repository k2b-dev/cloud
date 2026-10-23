import { lazySync } from "@k2b/cloud";
import { createAccess, updateAccess } from "@k2b/cloud/server";
import { audit, logger, trace } from "@k2b/cloud/services";
import { sql } from "bun";
import { type ConversationRow, memberUsers } from "./access";
import { chatLive } from "./live";
import { appendMessage, personSnapshots } from "./message-store";

const BATCH_SIZE = 100;
const log = logger("chat:maintenance");
export type ReconcileResult = {
  conversations: number;
  participantsRemoved: number;
  countsFixed: number;
  managersAssigned: number;
  failed: number;
};
export const reconcile = async (run: { signal: AbortSignal; heartbeat: () => unknown }): Promise<ReconcileResult> => {
  const result: ReconcileResult = { conversations: 0, participantsRemoved: 0, countsFixed: 0, managersAssigned: 0, failed: 0 };
  let cursor: string | null = null;
  while (!run.signal.aborted) {
    const rows: { id: string }[] = await sql<{ id: string }[]>`SELECT id FROM chat.conversations
      WHERE kind = 'chat' AND ${cursor ? sql`id > ${cursor}::uuid` : sql`true`} ORDER BY id LIMIT ${BATCH_SIZE}`;
    if (!rows.length) break;
    for (const entry of rows) {
      if (run.signal.aborted) break;
      try {
        const changed = await sql.begin(async (db) => {
          const [row] = await db<ConversationRow[]>`SELECT * FROM chat.conversations WHERE id = ${entry.id}::uuid FOR UPDATE`;
          if (!row || row.kind === "system") return null;
          // Deleted direct members stay as markers for Former account in derived titles.
          // Rows may therefore belong to deleted accounts; every chat.participants reader (fan-out, read receipts, counts, notifications) must apply the access condition or join auth.users.
          const removed = await db<
            { principal_id: string }[]
          >`DELETE FROM chat.participants p WHERE p.conversation_id = ${row.id}::uuid AND p.principal_type = 'user'
          AND NOT (p.origin = 'direct' AND NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = p.principal_id))
          AND NOT EXISTS (SELECT 1 FROM (${memberUsers(row.id, db)}) members WHERE members.id = p.principal_id) RETURNING principal_id`;
          const fixed = await db<{ id: string }[]>`WITH counted AS (SELECT COUNT(*)::int AS count FROM (${memberUsers(row.id, db)}) members)
          UPDATE chat.conversations SET member_count = counted.count FROM counted
          WHERE id = ${row.id}::uuid AND member_count <> counted.count RETURNING id`;
          const [manager] = await db<
            { user_id: string }[]
          >`SELECT a.user_id FROM chat.conversation_access ca JOIN auth.access a ON a.id = ca.access_id
          WHERE ca.conversation_id = ${row.id}::uuid AND ca.role = 'member' AND a.user_id IS NOT NULL AND a.permission = 'admin' LIMIT 1`;
          let assigned = false;
          if (!manager) {
            const [successor] = await db<{ id: string; access_id: string | null }[]>`
            SELECT u.id, (SELECT ca.access_id FROM chat.conversation_access ca JOIN auth.access a ON a.id = ca.access_id
              WHERE ca.conversation_id = ${row.id}::uuid AND ca.role = 'member' AND a.user_id = u.id ORDER BY ca.access_id LIMIT 1) AS access_id
            FROM (${memberUsers(row.id, db)}) members JOIN auth.users u ON u.id = members.id
            LEFT JOIN chat.participants p ON p.conversation_id = ${row.id}::uuid AND p.principal_type = 'user' AND p.principal_id = u.id
            WHERE (u.account_expires IS NULL OR u.account_expires > now())
            ORDER BY (p.joined_seq IS NULL), p.joined_seq, u.id LIMIT 1`;
            if (successor) {
              if (successor.access_id) {
                const updated = await updateAccess({ id: successor.access_id, permission: "admin" }, db);
                if (!updated.ok) throw new Error(updated.error.message);
              } else {
                const access = await createAccess({ principal: { type: "user", userId: successor.id }, permission: "admin" }, db);
                if (!access.ok) throw new Error(access.error.message);
                await db`INSERT INTO chat.conversation_access (conversation_id, access_id, role, added_by_type, added_by_id)
                VALUES (${row.id}::uuid, ${access.data.id}::uuid, 'member', 'user', ${successor.id}::uuid)`;
              }
              await db`INSERT INTO chat.participants (principal_type, principal_id, conversation_id, origin, joined_seq)
              SELECT 'user', ${successor.id}::uuid, id, 'direct', seq_head FROM chat.conversations WHERE id = ${row.id}::uuid
              ON CONFLICT (principal_type, principal_id, conversation_id) DO UPDATE SET origin = 'direct'`;
              const [member] = await personSnapshots(db, [successor.id]);
              await appendMessage(
                db,
                row,
                { accessSubject: { type: "user", userId: successor.id } },
                { kind: "system", system: { code: "manager_assigned", params: { member: member! } } },
                [successor.id],
              );
              await audit.record(
                {
                  action: "chat.member.succession",
                  outcome: "allowed",
                  actor: { uid: "chat-maintenance" },
                  target: { type: "chat_conversation", id: row.short_id },
                },
                db,
              );
              assigned = true;
            }
          }
          return { removed: removed.length, fixed: fixed.length, assigned };
        });
        if (changed) {
          result.conversations++;
          result.participantsRemoved += changed.removed;
          result.countsFixed += changed.fixed;
          result.managersAssigned += Number(changed.assigned);
          if (changed.assigned) chatLive.wake();
        }
      } catch (error) {
        result.failed++;
        log.error("Chat membership reconciliation failed", {
          conversationId: entry.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      await run.heartbeat();
    }
    cursor = rows.at(-1)!.id;
    if (rows.length < BATCH_SIZE) break;
  }
  return result;
};

const ID = "chat-maintenance";
const scheduler = lazySync((sync) =>
  sync.scheduler({ id: ID, delivery: { ackWaitMs: 60_000, maxAttempts: 3, backoffMs: [5_000, 15_000] } }),
);
let worker: Awaited<ReturnType<ReturnType<typeof scheduler>["process"]>> | undefined;
export const maintenanceLifecycle = {
  async start() {
    await scheduler().create({
      id: ID,
      cron: "*/15 * * * *",
      timezone: "UTC",
      misfire: "latest",
      meta: { appId: "chat", family: "chat:maintenance", source: ID, label: "Chat membership maintenance" },
      async process(context) {
        await trace.withSpan(
          {
            spanKey: trace.syncSpanKey("scheduler", ID, context.runId),
            name: "Chat membership maintenance",
            source: ID,
            appId: "chat",
            category: "schedule",
          },
          () => reconcile({ signal: context.signal, heartbeat: () => context.heartbeat() }),
          { summarize: (result) => result },
        );
      },
    });
    worker ??= await scheduler().process();
  },
  async stop() {
    const current = worker;
    worker = undefined;
    current?.stop();
    await current?.drain();
  },
};
