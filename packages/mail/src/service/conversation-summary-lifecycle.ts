import { deleteApplicationAiTasks, listUnreleasedApplicationAiTaskSources, releaseApplicationAiTask } from "@k2b/cloud/ai";
import { unwrap } from "@k2b/stdlib";
import { sql } from "bun";
import { z } from "zod";
import { releaseAiDailyBudget } from "./ai-daily-budget";
import { type MailRequestContext, userBackedActor } from "./auth";
import { conversationSummaryAiSourceId } from "./conversation-summary-ai";

type SummaryTask = {
  mailbox_id: string;
  conversation_id: string;
  basis: { throughMessageSeq: string | null; messageCount: number } | null;
  request_id: string;
  request: { context: MailRequestContext; source: { id: string } | null };
};

/** Settle with the durable request; interrupted requests retain their replay result. */
export const releaseConversationSummaryTask = async (db: typeof sql, row: SummaryTask): Promise<boolean> => {
  const person = row.request.source ? null : userBackedActor(row.request.context);
  return releaseApplicationAiTask(
    {
      appId: "mail",
      scopeId: row.mailbox_id,
      effectKey: row.request_id,
      ...(person ? { usageSubject: { type: "user" as const, userId: person.id } } : {}),
    },
    db,
  );
};

/** A discarded request must not leave an active inference without a future release owner. */
export const discardConversationSummaryTask = async (db: typeof sql, row: SummaryTask): Promise<void> => {
  if (await releaseConversationSummaryTask(db, row)) return;
  // No basis means this request has not begun inference.
  if (!row.basis) return;
  const person = row.request.source ? null : userBackedActor(row.request.context);
  await deleteApplicationAiTasks(
    {
      appId: "mail",
      scopeId: row.mailbox_id,
      sourceId: conversationSummaryAiSourceId({
        conversationId: row.conversation_id,
        effectKey: row.request_id,
        ...row.basis,
        ...(person ? { usageSubject: { type: "user" as const, userId: person.id } } : {}),
      }),
    },
    db,
  );
};

/** Hold the mailbox row lock before conversation locks; call late in the owner deletion transaction. */
export const discardConversationSummaries = async (
  db: typeof sql,
  scope: { mailboxId: string; conversationId?: string },
): Promise<void> => {
  const rows = await db<
    SummaryTask[]
  >`SELECT mailbox_id, conversation_id, basis, request_id, request FROM mail.conversation_summary_requests
    WHERE mailbox_id = ${scope.mailboxId}::uuid
      AND (${scope.conversationId ?? null}::uuid IS NULL OR conversation_id = ${scope.conversationId ?? null}::uuid)
      AND (${scope.conversationId ?? null}::uuid IS NOT NULL OR status IN ('pending','writing'))`;
  for (const row of rows) {
    if (row.request.source)
      unwrap(
        await releaseAiDailyBudget({ db, mailboxId: row.mailbox_id, sourceId: row.request.source.id, reservationKey: row.request_id }),
      );
    if (scope.conversationId) await discardConversationSummaryTask(db, row);
  }
  await db`DELETE FROM mail.conversation_summary_requests WHERE mailbox_id = ${scope.mailboxId}::uuid
    AND (${scope.conversationId ?? null}::uuid IS NULL OR conversation_id = ${scope.conversationId ?? null}::uuid)`;
  // Snapshot sources are composite. Conversation orphans are reconciled by exact identity;
  // released results keep their normal grace period. Only mailbox deletion clears a whole scope.
  if (!scope.conversationId) await deleteApplicationAiTasks({ appId: "mail", scopeId: scope.mailboxId }, db);
};

let sourceCursor: { scopeId: string; sourceId: string } | undefined;

/** Revisit all unreleased sources in bounded pages, preserving every live owner's recovery result. */
export const reconcileConversationSummaryTasks = async (): Promise<void> => {
  const sources = await listUnreleasedApplicationAiTaskSources({ appId: "mail", task: "conversation-summary", after: sourceCursor });
  for (const source of sources) {
    const mailboxId = z.uuid().safeParse(source.scopeId);
    const conversationId = z.uuid().safeParse(source.sourceId.split(":")[0]);
    if (!mailboxId.success || !conversationId.success) continue;
    await sql.begin(async (db) => {
      // Serialize with soft-delete/restore and new domain requests, before platform cleanup.
      const [mailbox] = await db<{ deleted_at: Date | null }[]>`SELECT deleted_at FROM mail.mailboxes
        WHERE id = ${mailboxId.data}::uuid FOR NO KEY UPDATE`;
      const owner =
        mailbox && !mailbox.deleted_at
          ? await db`SELECT id FROM mail.conversations WHERE id = ${conversationId.data}::uuid AND mailbox_id = ${mailboxId.data}::uuid`
          : [];
      if (!owner.length) await deleteApplicationAiTasks({ appId: "mail", scopeId: source.scopeId, sourceId: source.sourceId }, db);
    });
  }
  // A restart begins at the first page; the cursor is only a sweep optimization, never domain state.
  sourceCursor = sources.length === 100 ? sources.at(-1) : undefined;
};
