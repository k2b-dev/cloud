import { toPgUuidArray } from "@k2b/cloud/services";
import type { WorkflowJsonValue } from "@k2b/cloud/workflows";
import { sql } from "bun";
import { normalizeEmailAddress } from "./address-normalization";
import { sha256Json } from "./canonical";
import type { ConnectorProtocolFacts } from "./connectors";
import { parseMessageProtocolFacts } from "./message-protocol";

export type SqlClient = typeof sql;

export type FrozenMailAddress = {
  role: "from" | "reply_to" | "to" | "cc" | "bcc";
  name: string | null;
  email: string;
};

export type FrozenMailAttachment = {
  id: string;
  filename: string | null;
  contentType: string;
  disposition: string | null;
  contentId: string | null;
  sizeBytes: number;
};

export type FrozenMailMessage = {
  id: string;
  conversationId: string | null;
  subject: string;
  body: string;
  bodyText: string;
  bodyHtml: string;
  bodyAvailable: boolean;
  attachmentsAvailable: boolean;
  sender: FrozenMailAddress[];
  fromAddress: string;
  fromDomain: string;
  recipients: FrozenMailAddress[];
  attachments: FrozenMailAttachment[];
  hasAttachments: boolean;
  folderId: string;
  flags: string[];
  keywords: string[];
  direction: "inbound" | "outbound";
  internalDate: string;
  receivedAt: string;
  sentAt: string | null;
  protocolFacts?: ConnectorProtocolFacts;
};

export type FrozenMailConversation = {
  id: string;
  subject: string;
  summary: string | null;
  summaryRevision: number;
  assigneeUserId: string | null;
  workStatus: "needs_action" | "waiting" | "done";
  revision: number;
  latestMessageAt: string;
};

export type FrozenMailWorkflowSource = {
  message: FrozenMailMessage;
  conversation: FrozenMailConversation | null;
};

export type FrozenMailWorkflowPreconditions = {
  sourceHash: string;
  message: {
    id: string;
    remoteMessageRefId: string;
    folderId: string;
  };
  remoteState: {
    modseq: string | null;
    flags: string[];
    keywords: string[];
  };
  conversation: { id: string; revision: number } | null;
  triggerKind?: "messageReceived";
};

export type MailWorkflowTargetSnapshot = {
  targetKey: string;
  mailboxShortId: string;
  source: FrozenMailWorkflowSource;
  preconditions: FrozenMailWorkflowPreconditions;
  internalDate: string;
};

export const mailWorkflowEventContext = (snapshot: MailWorkflowTargetSnapshot): Record<string, WorkflowJsonValue> => ({
  mailboxId: snapshot.mailboxShortId,
  source: snapshot.source as unknown as WorkflowJsonValue,
  preconditions: snapshot.preconditions as unknown as WorkflowJsonValue,
});

type WorkflowSnapshotRow = {
  remote_message_ref_id: string;
  message_id: string;
  message_short_id: string;
  conversation_id: string | null;
  conversation_short_id: string | null;
  mailbox_short_id: string;
  subject: string;
  plain_text: string | null;
  sanitized_html: string | null;
  hydration_status: string;
  sender: FrozenMailAddress[] | string;
  recipients: FrozenMailAddress[] | string;
  attachments: FrozenMailAttachment[] | string;
  internal_date: Date | string;
  sent_at: Date | string | null;
  protocol_facts: ConnectorProtocolFacts | string;
  folder_id: string;
  folder_short_id: string;
  modseq: string | number | null;
  flags: string[] | null;
  keywords: string[] | null;
  direction: "inbound" | "outbound";
  conversation_subject: string | null;
  conversation_summary: string | null;
  summary_revision: string | number | null;
  collaboration_revision: string | number | null;
  assignee_user_id: string | null;
  work_status: "needs_action" | "waiting" | "done" | null;
  latest_message_at: Date | string | null;
};

const parseJson = <T>(value: T | string): T => (typeof value === "string" ? (JSON.parse(value) as T) : value);
const toIso = (value: Date | string): string => (value instanceof Date ? value : new Date(value)).toISOString();

const standardFlagNames: Record<string, string> = {
  "\\answered": "answered",
  "\\draft": "draft",
  "\\flagged": "flagged",
  "\\seen": "seen",
};

export const normalizeWorkflowFlags = (flags: readonly string[]): string[] =>
  flags.map((flag) => standardFlagNames[flag.toLowerCase()] ?? flag).sort();

const snapshotColumns = sql`
  rmr.id AS remote_message_ref_id,
  mc.id AS message_id,
  mc.short_id AS message_short_id,
  cm.conversation_id,
  conversation.short_id AS conversation_short_id,
  mailbox.short_id AS mailbox_short_id,
  mc.subject,
  mc.plain_text,
  mc.sanitized_html,
  mc.hydration_status,
  COALESCE(sender.value, '[]'::jsonb) AS sender,
  COALESCE(recipient.value, '[]'::jsonb) AS recipients,
  COALESCE(attachment.value, '[]'::jsonb) AS attachments,
  mc.internal_date,
  mc.sent_at,
  mc.protocol_facts,
  mp.folder_id,
  folder.short_id AS folder_short_id,
  rmr.modseq,
  mp.flags,
  mp.keywords,
  CASE WHEN EXISTS (
    SELECT 1
    FROM mail.message_addresses from_address
    JOIN mail.sender_identities identity
      ON identity.mailbox_id = mc.mailbox_id
     AND lower(identity.from_address) = from_address.normalized_email
    WHERE from_address.message_id = mc.id AND from_address.role = 'from'
  ) THEN 'outbound' ELSE 'inbound' END AS direction,
  conversation.subject AS conversation_subject,
  conversation.summary AS conversation_summary,
  conversation.summary_revision,
  conversation.revision AS collaboration_revision,
  conversation.assignee_user_id,
  conversation.work_status,
  conversation.latest_message_at
`;

const snapshotJoins = sql`
  JOIN mail.message_placements mp
    ON mp.remote_message_ref_id = rmr.id
   AND mp.folder_id = rmr.folder_id
  JOIN mail.message_contents mc ON mc.id = rmr.message_id
  JOIN mail.folders folder ON folder.id = rmr.folder_id
  JOIN mail.remote_resources resource ON resource.id = folder.remote_resource_id
  JOIN mail.mailboxes mailbox ON mailbox.id = resource.mailbox_id
  LEFT JOIN mail.conversation_messages cm ON cm.message_id = mc.id
  LEFT JOIN mail.conversations conversation ON conversation.id = cm.conversation_id
  LEFT JOIN LATERAL (
    SELECT jsonb_agg(jsonb_build_object(
      'role', address.role,
      'name', address.display_name,
      'email', address.email
    ) ORDER BY address.role, address.position) AS value
    FROM mail.message_addresses address
    WHERE address.message_id = mc.id AND address.role IN ('from', 'reply_to')
  ) sender ON true
  LEFT JOIN LATERAL (
    SELECT jsonb_agg(jsonb_build_object(
      'role', address.role,
      'name', address.display_name,
      'email', address.email
    ) ORDER BY address.role, address.position) AS value
    FROM mail.message_addresses address
    WHERE address.message_id = mc.id AND address.role IN ('to', 'cc', 'bcc')
  ) recipient ON true
  LEFT JOIN LATERAL (
    SELECT jsonb_agg(jsonb_build_object(
      'id', item.short_id,
      'filename', item.filename,
      'contentType', item.content_type,
      'disposition', item.disposition,
      'contentId', item.content_id,
      'sizeBytes', item.size_bytes
    ) ORDER BY item.id) AS value
    FROM mail.attachments item
    WHERE item.message_id = mc.id
  ) attachment ON true
`;

const mapSnapshot = (row: WorkflowSnapshotRow): MailWorkflowTargetSnapshot => {
  const internalDate = toIso(row.internal_date);
  const flags = normalizeWorkflowFlags(row.flags ?? []);
  const keywords = [...(row.keywords ?? [])].sort();
  const attachments = parseJson(row.attachments);
  const sender = parseJson<FrozenMailAddress[]>(row.sender);
  const rawFromAddress = sender.find((address) => address.role === "from")?.email ?? "";
  const fromAddress = normalizeEmailAddress(rawFromAddress) ?? rawFromAddress.trim().toLowerCase();
  const fromDomain = fromAddress.includes("@") ? fromAddress.slice(fromAddress.lastIndexOf("@") + 1) : "";
  const conversation =
    row.conversation_id && row.conversation_short_id && row.collaboration_revision != null && row.work_status && row.latest_message_at
      ? {
          id: row.conversation_short_id,
          subject: row.conversation_subject ?? "",
          summary: row.conversation_summary,
          summaryRevision: Number(row.summary_revision ?? 1),
          assigneeUserId: row.assignee_user_id,
          workStatus: row.work_status,
          revision: Number(row.collaboration_revision),
          latestMessageAt: toIso(row.latest_message_at),
        }
      : null;
  const source: FrozenMailWorkflowSource = {
    message: {
      id: row.message_short_id,
      conversationId: row.conversation_short_id,
      subject: row.subject,
      body: row.plain_text ?? "",
      bodyText: row.plain_text ?? "",
      bodyHtml: row.sanitized_html ?? "",
      bodyAvailable: row.hydration_status === "body" || row.hydration_status === "complete",
      attachmentsAvailable: row.hydration_status === "complete",
      sender,
      fromAddress,
      fromDomain,
      recipients: parseJson(row.recipients),
      attachments,
      hasAttachments: attachments.length > 0,
      folderId: row.folder_short_id,
      flags,
      keywords,
      direction: row.direction,
      internalDate,
      receivedAt: internalDate,
      sentAt: row.sent_at ? toIso(row.sent_at) : null,
      protocolFacts: parseMessageProtocolFacts(parseJson(row.protocol_facts)),
    },
    conversation,
  };
  return {
    targetKey: row.remote_message_ref_id,
    mailboxShortId: row.mailbox_short_id,
    source,
    preconditions: {
      sourceHash: sha256Json(source),
      message: {
        id: row.message_id,
        remoteMessageRefId: row.remote_message_ref_id,
        folderId: row.folder_id,
      },
      remoteState: {
        modseq: row.modseq == null ? null : String(row.modseq),
        flags: flags.filter((flag) => ["seen", "answered", "flagged", "draft"].includes(flag)),
        keywords,
      },
      conversation: row.conversation_id && conversation ? { id: row.conversation_id, revision: conversation.revision } : null,
    },
    internalDate,
  };
};

export const getWorkflowSnapshot = async (params: {
  mailboxId: string;
  remoteMessageRefId: string;
  db?: SqlClient;
}): Promise<MailWorkflowTargetSnapshot | null> => {
  const db = params.db ?? sql;
  const [row] = await db<WorkflowSnapshotRow[]>`
    SELECT ${snapshotColumns}
    FROM mail.remote_message_refs rmr
    ${snapshotJoins}
    WHERE resource.mailbox_id = ${params.mailboxId}::uuid
      AND rmr.id = ${params.remoteMessageRefId}::uuid
      AND rmr.stale_at IS NULL
      AND mp.deleted_at IS NULL
      AND folder.discovery_state = 'active'
  `;
  return row ? mapSnapshot(row) : null;
};

export const getWorkflowSnapshots = async (params: {
  mailboxId: string;
  remoteMessageRefIds: readonly string[];
  db?: SqlClient;
}): Promise<Map<string, MailWorkflowTargetSnapshot>> => {
  if (params.remoteMessageRefIds.length === 0) return new Map();
  const db = params.db ?? sql;
  const rows = await db<WorkflowSnapshotRow[]>`
    SELECT ${snapshotColumns}
    FROM mail.remote_message_refs rmr
    ${snapshotJoins}
    WHERE resource.mailbox_id = ${params.mailboxId}::uuid
      AND rmr.id = ANY(${toPgUuidArray([...params.remoteMessageRefIds])}::uuid[])
      AND rmr.stale_at IS NULL
      AND mp.deleted_at IS NULL
      AND folder.discovery_state = 'active'
  `;
  return new Map(rows.map(mapSnapshot).map((snapshot) => [snapshot.targetKey, snapshot]));
};
