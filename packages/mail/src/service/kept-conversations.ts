import { audit, escapeLikePattern } from "@k2b/cloud/services";
import { err, fail, ok, type Result } from "@k2b/stdlib";
import { sql } from "bun";
import { z } from "zod";
import type { KeptConversationExport } from "../kept-conversation-export";
import { actorRefFromRequest, auditActorFromRequest, type MailRequestContext, userBackedActor } from "./auth";
import { type ConversationKeep, canReadKeptConversations, recordConversationKeepAudit } from "./conversation-keeps";

export type KeptConversationSummary = {
  mailboxId: string;
  mailboxName: string;
  mailboxDeleted: boolean;
  conversationId: string;
  subject: string | null;
  sender: { name: string | null; address: string } | null;
  lastMessageAt: string | null;
  messageCount: number;
  keptAt: string;
  keptBy: Pick<ConversationKeep["keptBy"], "kind" | "id" | "displayName">;
};
export type KeepHistoryEntry = {
  action: string;
  outcome: "allowed" | "denied" | "failed";
  at: string;
  actor: { label: string };
  reason: string | null;
};
export type KeptConversationRef = { mailboxId: string; conversationId: string };
type SummaryRow = {
  mailbox_id: string;
  mailbox_short_id: string;
  mailbox_name: string;
  mailbox_deleted: boolean;
  conversation_id: string;
  conversation_short_id: string;
  subject: string | null;
  sender: KeptConversationSummary["sender"];
  latest_message_at: Date | string | null;
  message_count: number;
  kept_at: string;
  kept_by_kind: ConversationKeep["keptBy"]["kind"];
  kept_by_id: string | null;
  display_name: string;
};
const summarySelect = sql`SELECT keep.mailbox_id, mailbox.short_id AS mailbox_short_id, mailbox.name AS mailbox_name,
  mailbox.deleted_at IS NOT NULL AS mailbox_deleted, keep.conversation_id, conversation.short_id AS conversation_short_id,
  conversation.subject, conversation.latest_message_at,
  (SELECT count(*)::int FROM mail.conversation_messages link WHERE link.conversation_id = conversation.id) AS message_count,
  (SELECT jsonb_build_object('name', address.display_name, 'address', address.email)
    FROM mail.conversation_messages link
    JOIN mail.message_addresses address ON address.message_id = link.message_id AND address.role = 'from'
    WHERE link.conversation_id = conversation.id AND link.message_id = (SELECT first.message_id FROM mail.conversation_messages first
      WHERE first.conversation_id = conversation.id ORDER BY first.position, first.message_id LIMIT 1) ORDER BY address.position LIMIT 1) AS sender,
  keep.kept_at::text, keep.kept_by_kind, keep.kept_by_id,
  COALESCE(NULLIF(actor_user.display_name, ''), actor_user.uid, actor_service.name, actor_workflow.name,
    CASE keep.kept_by_kind WHEN 'workflow' THEN 'Workflow' WHEN 'system' THEN 'System'
      WHEN 'user' THEN 'Former user' ELSE 'Former service account' END) AS display_name
  FROM mail.conversation_keeps keep
  JOIN mail.mailboxes mailbox ON mailbox.id = keep.mailbox_id
  JOIN mail.conversations conversation ON conversation.id = keep.conversation_id AND conversation.mailbox_id = mailbox.id
  LEFT JOIN auth.users actor_user ON keep.kept_by_kind = 'user' AND actor_user.id = keep.kept_by_id
  LEFT JOIN auth.service_accounts actor_service ON keep.kept_by_kind = 'service_account' AND actor_service.id = keep.kept_by_id
  LEFT JOIN workflows.version actor_version ON keep.kept_by_kind = 'workflow' AND actor_version.id = keep.kept_by_id
  LEFT JOIN workflows.workflow actor_workflow ON actor_workflow.id = actor_version.workflow_id`;
const iso = (value: string | Date) => new Date(value).toISOString();
const summary = (row: SummaryRow): KeptConversationSummary => ({
  mailboxId: row.mailbox_id,
  mailboxName: row.mailbox_name,
  mailboxDeleted: row.mailbox_deleted,
  conversationId: row.conversation_id,
  subject: row.subject,
  sender: row.sender,
  lastMessageAt: row.latest_message_at ? iso(row.latest_message_at) : null,
  messageCount: row.message_count,
  keptAt: iso(row.kept_at),
  keptBy: { kind: row.kept_by_kind, id: row.kept_by_id, displayName: row.display_name },
});
const forbidden = () => fail(err.forbidden("Cloud administration access is required"));
const CursorSchema = z.object({ at: z.string().refine((v) => Number.isFinite(Date.parse(v))), id: z.uuid() });

export const listKeptConversations = async (
  context: MailRequestContext,
  options: { q?: string; cursor?: string; limit?: number } = {},
): Promise<Result<{ items: KeptConversationSummary[]; nextCursor: string | null; total: number }>> => {
  if (!(await canReadKeptConversations(context))) return forbidden();
  const limit = options.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 || (options.q?.length ?? 0) > 500 || (options.cursor?.length ?? 0) > 1000)
    return fail(err.badInput("Invalid kept conversation query"));
  let cursor: z.infer<typeof CursorSchema> | null = null;
  if (options.cursor) {
    try {
      cursor = CursorSchema.parse(JSON.parse(Buffer.from(options.cursor, "base64url").toString("utf8")));
    } catch {
      return fail(err.badInput("Invalid kept conversation cursor"));
    }
  }
  const pattern = `%${escapeLikePattern(options.q?.trim() ?? "")}%`;
  const filter = options.q?.trim()
    ? sql`(conversation.subject ILIKE ${pattern} OR mailbox.name ILIKE ${pattern}
    OR EXISTS (SELECT 1 FROM mail.conversation_messages search_link
      JOIN mail.message_addresses address ON address.message_id = search_link.message_id AND address.role = 'from'
      WHERE search_link.conversation_id = conversation.id AND (address.email ILIKE ${pattern} OR address.display_name ILIKE ${pattern})))`
    : sql`true`;
  const rows = await sql<SummaryRow[]>`${summarySelect} WHERE ${filter}
    ${cursor ? sql`AND (keep.kept_at, keep.conversation_id) < (${cursor.at}::timestamptz, ${cursor.id}::uuid)` : sql``}
    ORDER BY keep.kept_at DESC, keep.conversation_id DESC LIMIT ${limit + 1}`;
  const [count] = await sql<{ total: number }[]>`SELECT count(*)::int AS total FROM mail.conversation_keeps keep
    JOIN mail.mailboxes mailbox ON mailbox.id = keep.mailbox_id
    JOIN mail.conversations conversation ON conversation.id = keep.conversation_id WHERE ${filter}`;
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  // The list shows subjects and senders of mail the admin may hold no grant for, so every page is logged too.
  await audit.record({
    action: "mail.conversation.keep.list",
    outcome: "allowed",
    actor: auditActorFromRequest(context),
    requestId: context.requestId,
    metadata: {
      query: options.q?.trim() || null,
      principal: actorRefFromRequest(context),
      conversations: page.map((row) => ({ mailboxId: row.mailbox_id, conversationId: row.conversation_id })),
    },
  });
  return ok({
    items: page.map(summary),
    total: count?.total ?? 0,
    nextCursor:
      rows.length > limit && last
        ? Buffer.from(JSON.stringify({ at: last.kept_at, id: last.conversation_id })).toString("base64url")
        : null,
  });
};

const loadKept = async (ref: KeptConversationRef): Promise<SummaryRow | null> => {
  const [row] = await sql<SummaryRow[]>`${summarySelect}
    WHERE keep.mailbox_id = ${ref.mailboxId}::uuid AND keep.conversation_id = ${ref.conversationId}::uuid`;
  return row ?? null;
};
const exporterLabel = (context: MailRequestContext): string =>
  context.actor.kind === "service_account"
    ? context.actor.serviceAccount.name
    : userBackedActor(context)?.displayName || userBackedActor(context)?.uid || "User";
type ExportConversation = KeptConversationExport["conversations"][number];
type ExportMessage = ExportConversation["messages"][number];
const exportHeader = (row: SummaryRow): Omit<ExportConversation, "messages"> => ({
  cloudId: `${row.mailbox_short_id}/${row.conversation_short_id}`,
  mailbox: { id: row.mailbox_short_id, name: row.mailbox_name },
  conversationId: row.conversation_short_id,
  subject: row.subject,
  keep: { keptAt: iso(row.kept_at), keptBy: { kind: row.kept_by_kind, displayName: row.display_name } },
});
/** Use the existing (conversation_id, position, message_id) index; each pull holds at most one message body. */
async function* exportMessages(row: SummaryRow, detail = false): AsyncGenerator<ExportMessage> {
  let cursor: { position: string; id: string } | null = null;
  // Metadata is read in bounded keyset batches. Bodies are fetched one at a time, within Mail's hydration body limit.
  while (true) {
    const links: { message_id: string; position: string }[] = await sql`SELECT link.message_id, link.position::text
      FROM mail.conversation_messages link WHERE link.conversation_id = ${row.conversation_id}::uuid
        ${cursor ? sql`AND (link.position, link.message_id) > (${cursor.position}::bigint, ${cursor.id}::uuid)` : sql``}
      ORDER BY ${detail ? sql`link.position DESC, link.message_id DESC` : sql`link.position, link.message_id`} LIMIT 50`;
    if (!links.length) return;
    for (const link of links) {
      const [message] = await sql<{ document: ExportMessage }[]>`SELECT jsonb_build_object(
        'id', message.short_id, 'messageId', message.message_id,
        'delivery', (SELECT jsonb_build_object('state', outbox.state) FROM mail.outbox_submissions outbox WHERE outbox.message_id = message.id),
        'date', to_char(COALESCE(message.sent_at, message.internal_date) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'from', COALESCE((SELECT jsonb_agg(jsonb_build_object('name', display_name, 'address', email) ORDER BY position)
          FROM mail.message_addresses WHERE message_id = message.id AND role = 'from'), '[]'::jsonb),
        'replyTo', COALESCE((SELECT jsonb_agg(jsonb_build_object('name', display_name, 'address', email) ORDER BY position)
          FROM mail.message_addresses WHERE message_id = message.id AND role = 'reply_to'), '[]'::jsonb),
        'to', COALESCE((SELECT jsonb_agg(jsonb_build_object('name', display_name, 'address', email) ORDER BY position)
          FROM mail.message_addresses WHERE message_id = message.id AND role = 'to'), '[]'::jsonb),
        'cc', COALESCE((SELECT jsonb_agg(jsonb_build_object('name', display_name, 'address', email) ORDER BY position)
          FROM mail.message_addresses WHERE message_id = message.id AND role = 'cc'), '[]'::jsonb),
        'bcc', COALESCE((SELECT jsonb_agg(jsonb_build_object('name', display_name, 'address', email) ORDER BY position)
          FROM mail.message_addresses WHERE message_id = message.id AND role = 'bcc'), '[]'::jsonb),
        'subject', message.subject, 'inReplyTo', message.in_reply_to, 'references', message.reference_ids,
        'headers', message.selected_headers, 'text', message.plain_text, 'html', message.sanitized_html,
        'attachments', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', short_id, 'filename', filename,
          'contentType', content_type, 'size', size_bytes, 'inline', COALESCE(disposition = 'inline', false), 'contentId', content_id) ORDER BY id)
          FROM mail.attachments WHERE message_id = message.id), '[]'::jsonb)
      ) AS document FROM mail.message_contents message WHERE message.id = ${link.message_id}::uuid
        AND message.mailbox_id = ${row.mailbox_id}::uuid`;
      if (!message) throw new Error("Kept message disappeared while exporting");
      yield message.document;
    }
    if (detail) return;
    const last = links.at(-1)!;
    cursor = { position: last.position, id: last.message_id };
  }
}

/** The detail reader shows at most the newest 50 messages. The JSON export streams the entire conversation. */
export const getKeptConversation = async (
  context: MailRequestContext,
  ref: KeptConversationRef,
): Promise<Result<{ document: KeptConversationExport; history: KeepHistoryEntry[]; messageCount: number; messagesTruncated: boolean }>> => {
  if (!(await canReadKeptConversations(context))) {
    await recordConversationKeepAudit({ context, ...ref }, "mail.conversation.keep.view", "denied");
    return forbidden();
  }
  const row = await loadKept(ref);
  if (!row) return fail(err.notFound("Kept conversation"));
  await recordConversationKeepAudit({ context, ...ref }, "mail.conversation.keep.view", "allowed");
  const messages: ExportMessage[] = [];
  for await (const message of exportMessages(row, true)) messages.push(message);
  messages.reverse();
  const history = await sql<KeepHistoryEntry[]>`SELECT event.action, event.outcome,
    to_char(event.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at,
    jsonb_build_object('label', COALESCE(service.name, NULLIF(actor.display_name, ''), event.actor_uid,
      CASE WHEN event.metadata->'principal'->>'kind' = 'service_account' THEN 'Former service account' ELSE 'System' END)) AS actor,
    event.metadata->>'reason' AS reason
    FROM audit.events event
    LEFT JOIN auth.users actor ON actor.id = event.actor_user_id
    LEFT JOIN auth.service_accounts service ON service.id::text = event.metadata->'principal'->>'serviceAccountId'
    WHERE event.target_type = 'conversation' AND event.target_id = ${ref.conversationId}
      AND event.action LIKE 'mail.conversation.keep%'
    ORDER BY event.created_at DESC, event.id DESC LIMIT 50`;
  return ok({
    document: {
      schema: "cloud.mail.kept-conversations/v1",
      exportedAt: new Date().toISOString(),
      exportedBy: { label: exporterLabel(context) },
      conversations: [{ ...exportHeader(row), messages }],
    },
    history,
    messageCount: row.message_count,
    messagesTruncated: row.message_count > messages.length,
  });
};

/** All references are checked before returning a stream. Missing or no-longer-kept references reject the entire request with 404. */
export const exportKeptConversations = async (
  context: MailRequestContext,
  refs: KeptConversationRef[],
): Promise<Result<ReadableStream<Uint8Array>>> => {
  if (!(await canReadKeptConversations(context))) {
    const deniedRefs = new Map(refs.slice(0, 50).map((ref) => [`${ref.mailboxId}/${ref.conversationId}`, ref]));
    for (const ref of deniedRefs.values())
      await recordConversationKeepAudit({ context, ...ref }, "mail.conversation.keep.export", "denied");
    return forbidden();
  }
  if (refs.length < 1 || refs.length > 50) return fail(err.badInput("Export requires between 1 and 50 conversations"));
  const unique = [...new Map(refs.map((ref) => [`${ref.mailboxId}/${ref.conversationId}`, ref])).values()];
  const rows: SummaryRow[] = [];
  for (const ref of unique) {
    const row = await loadKept(ref);
    if (!row) return fail(err.notFound("Kept conversation"));
    rows.push(row);
  }
  for (const ref of unique) await recordConversationKeepAudit({ context, ...ref }, "mail.conversation.keep.export", "allowed");
  const exportedAt = new Date().toISOString();
  async function* chunks(): AsyncGenerator<Uint8Array> {
    const encoder = new TextEncoder();
    yield encoder.encode(
      `${JSON.stringify({ schema: "cloud.mail.kept-conversations/v1", exportedAt, exportedBy: { label: exporterLabel(context) } }).slice(
        0,
        -1,
      )},"conversations":[`,
    );
    for (const [index, row] of rows.entries()) {
      yield encoder.encode(`${index ? "," : ""}${JSON.stringify(exportHeader(row)).slice(0, -1)},"messages":[`);
      let first = true;
      let exported = 0;
      for await (const message of exportMessages(row)) {
        yield encoder.encode(`${first ? "" : ","}${JSON.stringify(message)}`);
        first = false;
        exported += 1;
      }
      // A merge or split during the download moves messages away between batches. Evidence must never arrive
      // silently incomplete, so the stream fails and the download shows an error instead.
      if (exported < row.message_count) throw new Error("A kept conversation changed while it was exported");
      yield encoder.encode("]}");
    }
    yield encoder.encode("]}");
  }
  const iterator = chunks();
  return ok(
    new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const next = await iterator.next();
          if (next.done) controller.close();
          else controller.enqueue(next.value);
        } catch (error) {
          controller.error(error);
          await iterator.return(undefined);
        }
      },
      async cancel() {
        await iterator.return(undefined);
      },
    }),
  );
};
