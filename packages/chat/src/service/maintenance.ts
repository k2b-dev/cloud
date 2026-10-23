import { lazySync } from "@k2b/cloud";
import { createAccess, updateAccess } from "@k2b/cloud/server";
import { audit, logger, trace } from "@k2b/cloud/services";
import { sql } from "bun";
import { type ConversationRow, memberUsers } from "./access";
import { chatLive } from "./live";
import { appendMessage, personSnapshots } from "./message-store";

const BATCH_SIZE = 100;
const log = logger("chat:maintenance");
// Match repairMemberCount: membership includes existing accounts regardless of status or kind.
const memberServices = (conversationId: string, db: typeof sql) => db`
  SELECT DISTINCT sa.id FROM chat.conversation_access ca JOIN auth.access a ON a.id = ca.access_id
  JOIN auth.service_accounts sa ON sa.id = a.service_account_id
  WHERE ca.conversation_id = ${conversationId}::uuid AND ca.role = 'member' AND a.permission IN ('read', 'write', 'admin')
`;
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
      WHERE ${cursor ? sql`id > ${cursor}::uuid` : sql`true`} ORDER BY id LIMIT ${BATCH_SIZE}`;
    if (!rows.length) break;
    for (const entry of rows) {
      if (run.signal.aborted) break;
      try {
        const changed = await sql.begin(async (db) => {
          const [row] = await db<ConversationRow[]>`SELECT * FROM chat.conversations WHERE id = ${entry.id}::uuid FOR UPDATE`;
          if (!row) return null;
          // Deleted direct members stay as markers for Former account in derived titles.
          // Participant readers must check access or join the matching identity table.
          const removed = await db<{ principal_id: string }[]>`DELETE FROM chat.participants p WHERE p.conversation_id = ${row.id}::uuid
          AND NOT (p.origin = 'direct' AND (
            (p.principal_type = 'user' AND NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = p.principal_id))
            OR (p.principal_type = 'service_account' AND NOT EXISTS (SELECT 1 FROM auth.service_accounts sa WHERE sa.id = p.principal_id))))
          AND NOT (
            (p.principal_type = 'user' AND EXISTS (SELECT 1 FROM (${memberUsers(row.id, db)}) members WHERE members.id = p.principal_id))
            OR (p.principal_type = 'service_account' AND EXISTS (SELECT 1 FROM (${memberServices(row.id, db)}) members WHERE members.id = p.principal_id)))
          RETURNING principal_id`;
          const fixed = await db<{ id: string }[]>`WITH counted AS (
            SELECT (SELECT COUNT(*)::int FROM (${memberUsers(row.id, db)}) members)
              + (SELECT COUNT(*)::int FROM (${memberServices(row.id, db)}) members) AS count)
          UPDATE chat.conversations SET member_count = counted.count FROM counted
          WHERE id = ${row.id}::uuid AND member_count <> counted.count RETURNING id`;
          const [manager] = await db<
            { id: string }[]
          >`SELECT a.id FROM chat.conversation_access ca JOIN auth.access a ON a.id = ca.access_id
          LEFT JOIN auth.service_accounts sa ON sa.id = a.service_account_id
          WHERE ca.conversation_id = ${row.id}::uuid AND ca.role = 'member' AND a.permission = 'admin'
            AND (a.user_id IS NOT NULL OR sa.kind IN ('standalone', 'agent')) LIMIT 1`;
          let assigned = false;
          if (!manager) {
            const [successor] = await db<{ id: string; principal_type: "user" | "service_account"; access_id: string | null }[]>`
            WITH candidates AS (
              SELECT u.id, 'user' AS principal_type FROM (${memberUsers(row.id, db)}) members JOIN auth.users u ON u.id = members.id
              WHERE u.account_expires IS NULL OR u.account_expires > now()
              UNION ALL
              SELECT sa.id, 'service_account' AS principal_type FROM (${memberServices(row.id, db)}) members
              JOIN auth.service_accounts sa ON sa.id = members.id WHERE sa.status = 'active' AND sa.kind IN ('standalone', 'agent')
            )
            SELECT members.id, members.principal_type,
              (SELECT ca.access_id FROM chat.conversation_access ca JOIN auth.access a ON a.id = ca.access_id
              WHERE ca.conversation_id = ${row.id}::uuid AND ca.role = 'member'
                AND ((members.principal_type = 'user' AND a.user_id = members.id)
                  OR (members.principal_type = 'service_account' AND a.service_account_id = members.id))
              ORDER BY ca.access_id LIMIT 1) AS access_id
            FROM candidates members LEFT JOIN chat.participants p ON p.conversation_id = ${row.id}::uuid
              AND p.principal_type = members.principal_type AND p.principal_id = members.id
            ORDER BY (p.joined_seq IS NULL), p.joined_seq, members.id, members.principal_type LIMIT 1`;
            if (successor) {
              const subject =
                successor.principal_type === "user"
                  ? { type: "user" as const, userId: successor.id }
                  : { type: "service_account" as const, serviceAccountId: successor.id };
              if (successor.access_id) {
                const updated = await updateAccess({ id: successor.access_id, permission: "admin" }, db);
                if (!updated.ok) throw new Error(updated.error.message);
              } else {
                const access = await createAccess({ principal: subject, permission: "admin" }, db);
                if (!access.ok) throw new Error(access.error.message);
                await db`INSERT INTO chat.conversation_access (conversation_id, access_id, role, added_by_type, added_by_id)
                VALUES (${row.id}::uuid, ${access.data.id}::uuid, 'member', ${successor.principal_type}, ${successor.id}::uuid)`;
              }
              await db`INSERT INTO chat.participants (principal_type, principal_id, conversation_id, origin, joined_seq)
              SELECT ${successor.principal_type}, ${successor.id}::uuid, id, 'direct', seq_head FROM chat.conversations WHERE id = ${row.id}::uuid
              ON CONFLICT (principal_type, principal_id, conversation_id) DO UPDATE SET origin = 'direct'`;
              const [member] = await personSnapshots(db, [successor.id], successor.principal_type);
              await appendMessage(
                db,
                row,
                { accessSubject: subject },
                { kind: "system", system: { code: "manager_assigned", params: { member: member! } } },
                [successor.principal_type === "user" ? successor.id : `service_account:${successor.id}`],
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
