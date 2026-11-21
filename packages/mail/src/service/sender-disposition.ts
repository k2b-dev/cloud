import { sql } from "@k2b/cloud";
import { err, fail, ok, type Result } from "@k2b/stdlib";
import { z } from "zod";
import { type MailingListDispositionResult, type SenderDispositionInput, senderDispositionInputSchema } from "../contracts";
import type { MailRequestContext } from "./auth";
import { queueBulkMoves } from "./bulk-disposition";
import { requireMailboxCollaborationPermission } from "./collaboration";
import { resolveRoleFolder } from "./folders";
import { normalizeSenderMatch, rejectOwnSenderTargets, senderMatchesSql } from "./sender-matching";

// The API translates public folder IDs before entering the service.
const internalSenderDispositionInputSchema = senderDispositionInputSchema.safeExtend({ folderId: z.string().uuid().optional() });

export const applySenderDisposition = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  input: SenderDispositionInput;
}): Promise<Result<MailingListDispositionResult>> => {
  const parsed = internalSenderDispositionInputSchema.safeParse(params.input);
  if (!parsed.success) return fail(err.badInput(parsed.error.issues[0]?.message ?? "Invalid sender disposition"));
  const access = await requireMailboxCollaborationPermission(params.context, params.mailboxId, "write");
  if (!access.ok) return access;
  const input = parsed.data;
  const normalized = normalizeSenderMatch(input.match, input.value);
  if (!normalized.ok) return normalized;
  const incoming = await rejectOwnSenderTargets({
    mailboxId: params.mailboxId,
    match: input.match,
    value: normalized.data,
    db: sql,
    message: "Choose an external sender; this address is one of the mailbox's own sender addresses",
  });
  if (!incoming.ok) return incoming;

  let destination: Result<{ id: string }>;
  if (input.destination) destination = await resolveRoleFolder(params.mailboxId, input.destination);
  else if (input.folderId) destination = await resolveDestinationFolder(params.mailboxId, input.folderId);
  else return fail(err.badInput("Choose exactly one destination or folderId"));
  if (!destination.ok) return destination;
  return queueBulkMoves({
    context: params.context,
    mailboxId: params.mailboxId,
    destinationFolderId: destination.data.id,
    idempotencyKey: input.idempotencyKey,
    matches: senderMatchesSql(input.match, normalized.data),
  });
};

const resolveDestinationFolder = async (mailboxId: string, folderId: string): Promise<Result<{ id: string }>> => {
  const [folder] = await sql<{ id: string }[]>`
    SELECT folder.id FROM mail.folders folder
    JOIN mail.remote_resources resource ON resource.id = folder.remote_resource_id
    WHERE folder.id = ${folderId}::uuid AND resource.mailbox_id = ${mailboxId}::uuid
      AND folder.discovery_state = 'active' AND folder.selectable
  `;
  return folder ? ok(folder) : fail(err.badInput("Destination must be an active selectable folder in this mailbox"));
};

export const senderPreviewQuerySchema = z.object({ match: z.enum(["sender", "domain"]), value: z.string().min(1).max(320) });

/** Bounded informational count; it never creates commands or rules. */
export const previewSenderMatches = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  input: z.infer<typeof senderPreviewQuerySchema>;
}) => {
  const access = await requireMailboxCollaborationPermission(params.context, params.mailboxId, "read");
  if (!access.ok) return access;
  const normalized = normalizeSenderMatch(params.input.match, params.input.value);
  if (!normalized.ok) return normalized;
  const [counts] = await sql<{ message_count: number; conversation_count: number }[]>`
    WITH matches AS (
      SELECT DISTINCT message.id
      FROM mail.message_contents message
      JOIN mail.remote_message_refs remote_ref ON remote_ref.message_id = message.id AND remote_ref.stale_at IS NULL
      JOIN mail.message_placements placement ON placement.remote_message_ref_id = remote_ref.id AND placement.deleted_at IS NULL
      JOIN mail.folders folder ON folder.id = placement.folder_id AND folder.discovery_state = 'active'
      JOIN mail.remote_resources resource ON resource.id = folder.remote_resource_id
      WHERE resource.mailbox_id = ${params.mailboxId}::uuid AND ${senderMatchesSql(params.input.match, normalized.data)}
        AND folder.role NOT IN ('sent', 'drafts', 'trash', 'junk')
      LIMIT 501
    ) SELECT count(DISTINCT matches.id)::int AS message_count,
      count(DISTINCT cm.conversation_id)::int AS conversation_count
      FROM matches LEFT JOIN mail.conversation_messages cm ON cm.message_id = matches.id
  `;
  return ok({
    messageCount: counts?.message_count ?? 0,
    conversationCount: counts?.conversation_count ?? 0,
    capped: (counts?.message_count ?? 0) > 500,
    applicationLimit: 500,
  });
};
