import { err, fail, ok, type Result } from "@k2b/stdlib";
import { sql } from "bun";
import { z } from "zod";
import { type MailingListDispositionResult, type SenderDispositionInput, senderDispositionInputSchema } from "../contracts";
import type { MailRequestContext } from "./auth";
import { queueBulkMoves } from "./bulk-disposition";
import { requireMailboxCollaborationPermission } from "./collaboration";
import { resolveRoleFolder } from "./folders";
import { normalizeSenderMatch, rejectOwnSenderTargets, senderMatchesSql } from "./incoming-automations";

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
    conditions: {
      mode: "all",
      items: [{ field: input.match === "sender" ? "sender_address" : "sender_domain", operator: "is", value: normalized.data }],
    },
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
