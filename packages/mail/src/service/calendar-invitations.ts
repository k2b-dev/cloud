import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { err, fail, ok, type Result } from "@k2b/stdlib";
import { sql } from "bun";
import type { CalendarAddress, CalendarParticipationStatus, SpacesMailDestinationContext } from "../app-integration-contracts";
import type { MailDraft } from "../contracts";
import { withShortIdDb } from "../lib/short-id";
import { requireMailboxPermission } from "./access";
import {
  type AppIntegrationRequest,
  buildCalendarInvitationResponse,
  commitCalendarInvitationResponse,
  commitEventInvitation,
  createCalendarEvent,
  getCalendarSpace,
  getSpacesMailIntegrationAvailability,
  importCalendarInvitation,
  listCalendarDestinations,
  listCalendarEvents,
  prepareEventInvitation,
  previewCalendarInvitation,
} from "./app-integrations";
import type { MailRequestContext } from "./auth";
import { enqueueDraftProjection } from "./draft-provider-projection";
import * as draftUploads from "./draft-uploads";
import * as drafts from "./drafts";
import { storeReadableBlob } from "./message-blobs";
import * as messages from "./messages";
import { publicIds, requirePublicId } from "./public-resources";
import * as senderIdentities from "./sender-identities";

const MAX_CALENDAR_BYTES = 1_000_000;

export const composerIntegrationAvailable = async (): Promise<boolean> => (await getSpacesMailIntegrationAvailability()).composer;

export const visibleInvitationAttendees = (draft: Pick<MailDraft, "to" | "cc">, organizerAddress: string): CalendarAddress[] => {
  const organizer = organizerAddress.trim().toLowerCase();
  const recipients = new Map<string, CalendarAddress>();
  for (const recipient of [...draft.to, ...draft.cc]) {
    const address = recipient.address.trim().toLowerCase();
    if (address === organizer || recipients.has(address)) continue;
    recipients.set(address, { name: recipient.name?.trim() || null, address });
  }
  return [...recipients.values()];
};

type IntegrationFailure = { message: string; status: number };

const integrationFailure = (result: IntegrationFailure) => {
  if (result.status === 400) return fail(err.badInput(result.message));
  if (result.status === 403) return fail(err.forbidden(result.message));
  if (result.status === 404) return fail(err.notFound(result.message));
  if (result.status === 409) return fail(err.conflict(result.message));
  return fail(err.internal(result.message));
};

const chooseVerifiedIdentity = (
  identities: Awaited<ReturnType<typeof senderIdentities.listSenderIdentities>>,
  preferredAddresses: string[],
) => {
  if (!identities.ok) return identities;
  const preferred = new Set(preferredAddresses.map((address) => address.trim().toLowerCase()));
  const identity =
    identities.data.find((candidate) => candidate.status === "verified" && preferred.has(candidate.fromAddress.toLowerCase())) ??
    identities.data.find((candidate) => candidate.isDefault && candidate.status === "verified") ??
    identities.data.find((candidate) => candidate.status === "verified");
  return identity ? ok(identity) : fail(err.badInput("Verify a sending identity before creating a calendar message"));
};

const attachCalendar = async (params: {
  draftId: string;
  filename: string;
  method: "REQUEST" | "REPLY" | "CANCEL";
  calendar: string;
}): Promise<Result<void>> => {
  const bytes = Buffer.from(params.calendar, "utf8");
  const blob = await storeReadableBlob(Readable.from(bytes), bytes.byteLength);
  try {
    await sql.begin(async (tx) => {
      const rows = await withShortIdDb(
        tx,
        "draftAttachment",
        (db, shortId) => db<{ id: string }[]>`
        INSERT INTO mail.draft_attachments (short_id, draft_id, blob_id, filename, content_type, byte_length, content_hash, position)
        VALUES (
          ${shortId}, ${params.draftId}::uuid, ${blob.id}::uuid, ${params.filename},
          ${`text/calendar; method=${params.method}; charset=utf-8`}, ${bytes.byteLength}, ${blob.contentHash}, 0
        )
        ON CONFLICT (draft_id, position) DO NOTHING
        RETURNING id
      `,
      );
      if (rows.length > 0) await tx`UPDATE mail.drafts SET revision = revision + 1 WHERE id = ${params.draftId}::uuid`;
    });
  } catch {
    // Blobs are content addressed, so this one may already back other attachments or messages.
    // deleteOrphanedBlobs sweeps it if nothing references it.
    return fail(err.internal("Failed to attach the calendar payload"));
  }
  await enqueueDraftProjection(params.draftId);
  return ok(undefined);
};

const createCalendarDraft = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  idempotencyKey: string;
  to: CalendarAddress[];
  subject: string;
  body: string;
  calendar: string;
  filename: string;
  method: "REQUEST" | "REPLY" | "CANCEL";
  senderIdentityId: string;
}): Promise<Result<MailDraft>> => {
  const allowed = await requireMailboxPermission(params.context, params.mailboxId, "write");
  if (!allowed.ok) return allowed;
  const input = {
    senderIdentityId: params.senderIdentityId,
    to: params.to,
    cc: [],
    bcc: [],
    subject: params.subject,
    body: params.body,
    format: "plain" as const,
    priority: "normal" as const,
    requestDeliveryReceipt: false,
    requestReadReceipt: false,
  };
  const created = await drafts.materializeDraftSeed({
    context: params.context,
    mailboxId: params.mailboxId,
    input: {
      idempotencyKey: params.idempotencyKey,
      origin: { kind: "compose", input: { ...input, intent: "new" } },
      draft: input,
    },
  });
  if (!created.ok) return created;
  if (!created.data.attachments.some((attachment) => attachment.contentType.startsWith("text/calendar"))) {
    const attached = await attachCalendar({ ...params, draftId: created.data.id });
    if (!attached.ok) return attached;
  }
  return drafts.getDraft(params.context, params.mailboxId, created.data.id);
};

const loadCalendarAttachment = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  messageId: string;
}): Promise<
  Result<{
    calendar: string;
    attachmentId: string;
    recipientAddresses: string[];
    publicMailboxId: string;
    publicMessageId: string;
    conversation: { ref: { type: "mail.conversation"; id: string }; label: string };
  }>
> => {
  const message = await messages.getMessage({ context: params.context, mailboxId: params.mailboxId, messageId: params.messageId });
  if (!message.ok) return message;
  const attachment = message.data.attachments.find(
    (candidate) =>
      candidate.contentType.split(";", 1)[0]?.trim().toLowerCase() === "text/calendar" ||
      candidate.filename?.toLowerCase().endsWith(".ics"),
  );
  if (!attachment) return fail(err.notFound("Calendar invitation"));
  if (attachment.sizeBytes > MAX_CALENDAR_BYTES) return fail(err.badInput("Calendar attachment is too large"));
  const opened = await messages.openAttachment({ ...params, attachmentId: attachment.id });
  if (!opened.ok) return opened;
  const chunks = await sql<{ position: number; bytes: Uint8Array }[]>`
    SELECT position, bytes
    FROM mail.message_part_chunks
    WHERE blob_id = ${opened.data.blobId}::uuid
    ORDER BY position
  `;
  if (chunks.length !== opened.data.chunkCount || chunks.some((chunk, index) => chunk.position !== index)) {
    return fail(err.internal("Calendar attachment is incomplete"));
  }
  const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk.bytes)));
  if (bytes.byteLength !== opened.data.total) return fail(err.internal("Calendar attachment length is invalid"));
  const [conversation] = await sql<{ id: string; subject: string }[]>`
    SELECT conversation.id, conversation.subject
    FROM mail.conversation_messages link
    JOIN mail.conversations conversation ON conversation.id = link.conversation_id
    WHERE link.message_id = ${params.messageId}::uuid AND conversation.mailbox_id = ${params.mailboxId}::uuid
    LIMIT 1
  `;
  if (!conversation) return fail(err.notFound("Conversation"));
  const [conversationIds, mailboxIds, messageIds] = await Promise.all([
    publicIds("conversations", [conversation.id]),
    publicIds("mailboxes", [params.mailboxId]),
    publicIds("messages", [params.messageId]),
  ]);
  return ok({
    calendar: new TextDecoder("utf-8", { fatal: false }).decode(bytes),
    attachmentId: attachment.id,
    recipientAddresses: [...message.data.to, ...message.data.cc].map((address) => address.address),
    publicMailboxId: requirePublicId(mailboxIds, params.mailboxId),
    publicMessageId: requirePublicId(messageIds, params.messageId),
    conversation: {
      ref: { type: "mail.conversation", id: requirePublicId(conversationIds, conversation.id) },
      label: conversation.subject.trim().slice(0, 500) || "(No subject)",
    },
  });
};

const loadDestinationContext = async (params: {
  mailboxId: string;
  request: AppIntegrationRequest;
}): Promise<Result<SpacesMailDestinationContext>> => {
  const [result, rows] = await Promise.all([
    listCalendarDestinations(params.request),
    sql<{ calendar_space_id: string | null }[]>`
      SELECT calendar_space_id FROM mail.mailboxes
      WHERE id = ${params.mailboxId}::uuid AND deleted_at IS NULL
    `,
  ]);
  if (!result.ok) return integrationFailure(result);
  const savedSpaceId = rows[0]?.calendar_space_id ?? null;
  return ok({
    selectedSpaceId: result.data.some((item) => item.id === savedSpaceId) ? savedSpaceId : null,
    items: result.data,
  });
};

export const listDestinations = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  request: AppIntegrationRequest;
}): Promise<Result<SpacesMailDestinationContext>> => {
  const allowed = await requireMailboxPermission(params.context, params.mailboxId, "write");
  return allowed.ok ? loadDestinationContext(params) : allowed;
};

export const setDefaultDestination = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  spaceId: string | null;
  request: AppIntegrationRequest;
}): Promise<Result<SpacesMailDestinationContext>> => {
  const allowed = await requireMailboxPermission(params.context, params.mailboxId, "admin");
  if (!allowed.ok) return allowed;
  if (!params.spaceId) {
    const [updated] = await sql<{ id: string }[]>`
      UPDATE mail.mailboxes
      SET calendar_space_id = NULL, updated_at = now()
      WHERE id = ${params.mailboxId}::uuid AND deleted_at IS NULL
      RETURNING id
    `;
    if (!updated) return fail(err.notFound("Mailbox"));
    const destinations = await listCalendarDestinations(params.request);
    return ok({ selectedSpaceId: null, items: destinations.ok ? destinations.data : [] });
  }
  const destinations = await loadDestinationContext(params);
  if (!destinations.ok) return destinations;
  if (!destinations.data.items.some((item) => item.id === params.spaceId)) {
    return fail(err.badInput("Choose a writable Space"));
  }
  const [updated] = await sql<{ id: string }[]>`
    UPDATE mail.mailboxes
    SET calendar_space_id = ${params.spaceId}::uuid, updated_at = now()
    WHERE id = ${params.mailboxId}::uuid AND deleted_at IS NULL
    RETURNING id
  `;
  if (!updated) return fail(err.notFound("Mailbox"));
  return ok({ selectedSpaceId: params.spaceId, items: destinations.data.items });
};

export const listComposerEvents = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  spaceId: string;
  query?: string;
  request: AppIntegrationRequest;
}) => {
  const allowed = await requireMailboxPermission(params.context, params.mailboxId, "write");
  if (!allowed.ok) return allowed;
  const result = await listCalendarEvents(params.spaceId, params.request, params.query);
  return result.ok ? ok(result.data) : integrationFailure(result);
};

export const createComposerEvent = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  spaceId: string;
  title: string;
  location?: string;
  startsAt: string;
  endsAt: string;
  request: AppIntegrationRequest;
}) => {
  const allowed = await requireMailboxPermission(params.context, params.mailboxId, "write");
  if (!allowed.ok) return allowed;
  const space = await getCalendarSpace(params.spaceId, params.request);
  if (!space.ok) return integrationFailure(space);
  if (space.data.permission === "read") return fail(err.forbidden("Write access to the selected Space is required"));
  const column = space.data.columns.find((candidate) => !candidate.isDone);
  if (!column) return fail(err.badInput("The selected Space has no active column for a new event"));
  const result = await createCalendarEvent(
    {
      spaceId: params.spaceId,
      columnId: column.id,
      title: params.title,
      location: params.location?.trim() || undefined,
      startsAt: params.startsAt,
      endsAt: params.endsAt,
      allDay: false,
    },
    params.request,
  );
  return result.ok ? ok(result.data) : integrationFailure(result);
};

export const attachEventInvitation = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  draftId: string;
  itemId: string;
  idempotencyKey: string;
  request: AppIntegrationRequest;
}): Promise<Result<MailDraft>> => {
  const allowed = await requireMailboxPermission(params.context, params.mailboxId, "write");
  if (!allowed.ok) return allowed;
  const [current, identities] = await Promise.all([
    drafts.getDraft(params.context, params.mailboxId, params.draftId),
    senderIdentities.listSenderIdentities(params.context, params.mailboxId),
  ]);
  if (!current.ok) return current;
  if (!identities.ok) return identities;
  if (current.data.state !== "draft") return fail(err.conflict("Only an editable draft can receive an invitation"));
  const identity = identities.data.find((candidate) => candidate.id === current.data.senderIdentityId && candidate.status === "verified");
  if (!identity) return fail(err.badInput("The draft sender identity is no longer verified"));

  const attendees = visibleInvitationAttendees(current.data, identity.fromAddress);
  if (attendees.length === 0) return fail(err.badInput("Add at least one To or Cc recipient before attaching an invitation"));

  const prepared = await prepareEventInvitation(
    {
      itemId: params.itemId,
      mailboxId: params.mailboxId,
      draftId: params.draftId,
      senderIdentityId: identity.id,
      organizer: { name: identity.displayName?.trim() || null, address: identity.fromAddress },
      attendees,
    },
    params.request,
    params.idempotencyKey,
  );
  if (!prepared.ok) return integrationFailure(prepared);

  const bytes = Buffer.from(prepared.data.calendar, "utf8");
  const contentHash = createHash("sha256").update(bytes).digest("hex");
  let updated = current.data;
  const alreadyAttached = updated.attachments.some(
    (attachment) => attachment.contentHash === contentHash && attachment.filename === prepared.data.filename,
  );
  if (!alreadyAttached) {
    const uploaded = await draftUploads.uploadDraftAttachmentStream({
      context: params.context,
      mailboxId: params.mailboxId,
      draftId: params.draftId,
      expectedRevision: updated.revision,
      filename: prepared.data.filename,
      contentType: prepared.data.contentType,
      byteLength: bytes.byteLength,
      stream: Readable.from(bytes),
    });
    if (!uploaded.ok) return uploaded;
    updated = uploaded.data;
  }

  const committed = await commitEventInvitation({ deliveryId: prepared.data.deliveryId }, params.request);
  if (!committed.ok) {
    return fail(err.internal(`The invitation was attached, but Spaces could not record it: ${committed.message}`));
  }
  return ok(updated);
};

export const preview = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  messageId: string;
  request: AppIntegrationRequest;
}) => {
  const loaded = await loadCalendarAttachment(params);
  if (!loaded.ok) return loaded;
  const result = await previewCalendarInvitation(
    { mailboxId: loaded.data.publicMailboxId, messageId: loaded.data.publicMessageId, calendar: loaded.data.calendar },
    params.request,
  );
  return result.ok ? ok(result.data) : integrationFailure(result);
};

export const importToSpace = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  messageId: string;
  spaceId?: string;
  request: AppIntegrationRequest;
}) => {
  const allowed = await requireMailboxPermission(params.context, params.mailboxId, "write");
  if (!allowed.ok) return allowed;
  const savedDestination = params.spaceId ? null : await loadDestinationContext(params);
  if (savedDestination && !savedDestination.ok) return savedDestination;
  const destination = params.spaceId ?? savedDestination?.data.selectedSpaceId;
  if (!destination) return fail(err.badInput("Choose a destination Space first"));
  const loaded = await loadCalendarAttachment(params);
  if (!loaded.ok) return loaded;
  const result = await importCalendarInvitation(
    {
      mailboxId: loaded.data.publicMailboxId,
      messageId: loaded.data.publicMessageId,
      spaceId: destination,
      calendar: loaded.data.calendar,
      conversation: loaded.data.conversation,
    },
    params.request,
  );
  return result.ok ? ok(result.data) : integrationFailure(result);
};

export const createResponseDraft = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  messageId: string;
  participationStatus: CalendarParticipationStatus;
  idempotencyKey: string;
  spaceId?: string;
  request: AppIntegrationRequest;
}): Promise<Result<MailDraft>> => {
  const allowed = await requireMailboxPermission(params.context, params.mailboxId, "write");
  if (!allowed.ok) return allowed;
  const [loaded, identities] = await Promise.all([
    loadCalendarAttachment(params),
    senderIdentities.listSenderIdentities(params.context, params.mailboxId),
  ]);
  if (!loaded.ok) return loaded;
  const identity = chooseVerifiedIdentity(identities, loaded.data.recipientAddresses);
  if (!identity.ok) return identity;
  const savedDestination = params.spaceId ? null : await loadDestinationContext(params);
  if (savedDestination && !savedDestination.ok) return savedDestination;
  const destination = params.spaceId ?? savedDestination?.data.selectedSpaceId;
  if (!destination) return fail(err.badInput("Choose a destination Space first"));
  const imported = await importCalendarInvitation(
    {
      mailboxId: loaded.data.publicMailboxId,
      messageId: loaded.data.publicMessageId,
      spaceId: destination,
      calendar: loaded.data.calendar,
      conversation: loaded.data.conversation,
    },
    params.request,
  );
  if (!imported.ok) return integrationFailure(imported);
  const response = await buildCalendarInvitationResponse(
    {
      mailboxId: loaded.data.publicMailboxId,
      messageId: loaded.data.publicMessageId,
      calendar: loaded.data.calendar,
      participationStatus: params.participationStatus,
      attendee: { name: identity.data.displayName || null, address: identity.data.fromAddress },
    },
    params.request,
  );
  if (!response.ok) return integrationFailure(response);
  const draft = await createCalendarDraft({
    context: params.context,
    mailboxId: params.mailboxId,
    idempotencyKey: params.idempotencyKey,
    to: [response.data.to],
    subject: response.data.subject,
    body: response.data.body,
    calendar: response.data.calendar,
    filename: "invite-response.ics",
    method: "REPLY",
    senderIdentityId: identity.data.id,
  });
  if (!draft.ok) {
    return fail(err.internal(`The event was saved in Spaces, but the response draft could not be created: ${draft.error.message}`));
  }
  const committed = await commitCalendarInvitationResponse(
    {
      mailboxId: loaded.data.publicMailboxId,
      messageId: loaded.data.publicMessageId,
      participationStatus: params.participationStatus,
      draftId: requirePublicId(await publicIds("drafts", [draft.data.id]), draft.data.id),
    },
    params.request,
  );
  return committed.ok ? draft : fail(err.internal(`The response draft was created, but Spaces could not record it: ${committed.message}`));
};
