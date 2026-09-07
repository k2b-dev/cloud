import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { Readable } from "node:stream";
import { encryptSecret } from "@valentinkolb/cloud/services";
import { sql } from "bun";
import { mailCapabilities } from "../capabilities";
import { ConversationGetDataSchema } from "../capability-contracts";
import { unavailableProviderLimitSnapshot } from "../contracts";
import { newShortId } from "../lib/short-id";
import { migrate } from "../migrate";
import { grantMailboxAccess, listMailboxAccess, revokeMailboxAccess } from "./access";
import { MAIL_ATTACHMENT_EXTRACTOR_VERSION } from "./attachment-extraction-contract";
import type { MailRequestContext } from "./auth";
import { executeMutationCommand, executeOutboxSubmission, executeOutboxSubmissionWithHeartbeat } from "./command-runtime";
import { createActorCommand } from "./commands";
import { reviewDraftComposeSafety } from "./compose-safety";
import type { ConnectorEnvelope } from "./connectors";
import { imapSmtpConnector } from "./connectors";
import { getConversationSummary, updateConversationSummary } from "./conversation-summary";
import { acquireDraftLease, getDraftLease, heartbeatDraftLease, releaseDraftLease } from "./draft-leases";
import { recordDraftFolderSyncInTransaction } from "./draft-provider-projection";
import {
  appendDraftAttachmentUpload,
  cancelDraftAttachmentUpload,
  createDraftAttachmentUpload,
  finalizeDraftAttachmentUpload,
  getDraftAttachmentUpload,
  uploadDraftAttachmentStream,
} from "./draft-uploads";
import {
  createDeliveryRecoveryDraft,
  createDraft,
  deriveDraftFromMessage,
  discardDraft,
  getDraft,
  listConversationDrafts,
  listDraftRecoveryCopies,
  materializeDraftSeed,
  prepareDraftSeed,
  removeDraftAttachment,
  restoreDraftRecoveryCopy,
  updateDraft,
} from "./drafts";
import { latestMailInvalidationCursor, liveMailInvalidations } from "./events";
import { resolveMailExecution } from "./execution";
import { createLocalTag, setConversationLocalTags } from "./local-tags";
import { createMailbox, updateMailbox } from "./mailboxes";
import { deleteOrphanedBlobs, storeReadableBlob } from "./message-blobs";
import { hydrateMessageFromSource } from "./message-hydration";
import { recordMessageReceipt } from "./message-receipts";
import {
  createAttachmentStream,
  getConversationViewCounts,
  getMessage,
  listConversationMessages,
  listConversations,
  openAttachment,
} from "./messages";
import { createProviderConnection, listProviderConnections, replaceProviderConnection } from "./provider-connections";
import { MAIL_PROVIDER_OPERATION_LEASE_MS, mailProviderOperationMutex } from "./provider-operation-lock";
import { cancelScheduledSend, cancelSendCommand, listScheduledSends } from "./scheduled-sends";
import { searchMessages } from "./search";
import { ingestEnvelope } from "./sync-runtime";
import { createConversationTriageCommands } from "./triage";

const enabled = process.env.MAIL_INTEGRATION_TESTS === "1";
const suite = enabled ? describe : describe.skip;

suite("mail PostgreSQL foundation", () => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const ids: { userIds: string[]; mailboxId?: string; accessIds: string[]; blobIds: string[] } = {
    userIds: [],
    accessIds: [],
    blobIds: [],
  };
  let context: MailRequestContext;

  const publicConversationId = async (id: string): Promise<string> => {
    const [row] = await sql<{ short_id: string }[]>`SELECT short_id FROM mail.conversations WHERE id = ${id}::uuid`;
    if (!row) throw new Error("Conversation fixture is missing its public ID");
    return row.short_id;
  };

  const publicMailboxId = async (id: string): Promise<string> => {
    const [row] = await sql<{ short_id: string }[]>`SELECT short_id FROM mail.mailboxes WHERE id = ${id}::uuid`;
    if (!row) throw new Error("Mailbox fixture is missing its public ID");
    return row.short_id;
  };

  const publicTagId = async (id: string): Promise<string> => {
    const [row] = await sql<{ short_id: string }[]>`SELECT short_id FROM mail.local_tags WHERE id = ${id}::uuid`;
    if (!row) throw new Error("Tag fixture is missing its public ID");
    return row.short_id;
  };

  beforeAll(async () => {
    await migrate();
    await migrate();
    const [user] = await sql<{ id: string }[]>`
      INSERT INTO auth.users (uid, provider, profile, display_name, admin)
      VALUES (${`mail-test-${suffix}`}, 'local', 'user', 'Mail Integration Test', true)
      RETURNING id
    `;
    if (!user) throw new Error("Failed to create integration user");
    ids.userIds.push(user.id);
    context = {
      actor: {
        kind: "user",
        user: {
          id: user.id,
          uid: `mail-test-${suffix}`,
          provider: "local",
          profile: "user",
          displayName: "Mail Integration Test",
          givenName: "Mail",
          sn: "Test",
          mail: `mail-test-${suffix}@example.com`,
          roles: ["admin", "user"],
          memberofGroupIds: [],
          memberofGroups: [],
        } as never,
      },
      accessSubject: { type: "user", userId: user.id },
      requestId: `mail-integration-${suffix}`,
    };
  });

  afterAll(async () => {
    if (ids.mailboxId) {
      const access = await sql<
        { access_id: string }[]
      >`SELECT access_id FROM mail.mailbox_access WHERE mailbox_id = ${ids.mailboxId}::uuid`;
      ids.accessIds.push(...access.map((row) => row.access_id));
      await sql`DELETE FROM mail.mailboxes WHERE id = ${ids.mailboxId}::uuid`;
    }
    if (ids.accessIds.length > 0) {
      await sql`DELETE FROM auth.access WHERE id IN (SELECT value::uuid FROM jsonb_array_elements_text(${ids.accessIds}::jsonb))`;
    }
    if (ids.blobIds.length > 0) {
      await sql`DELETE FROM mail.message_part_blobs WHERE id IN (SELECT value::uuid FROM jsonb_array_elements_text(${ids.blobIds}::jsonb))`;
    }
    if (ids.userIds.length > 0) {
      await sql`DELETE FROM auth.users WHERE id IN (SELECT value::uuid FROM jsonb_array_elements_text(${ids.userIds}::jsonb))`;
    }
  });

  test("persists a pinned send command and supports mailbox-scoped search", async () => {
    const mailbox = await createMailbox(context, {
      name: `Integration ${suffix}`,
      description: "Disposable integration mailbox",
    });
    expect(mailbox.ok).toBe(true);
    if (!mailbox.ok) return;
    ids.mailboxId = mailbox.data.id;
    expect(mailbox.data.searchBackend).toBe("auto");

    const nativeSearch = await updateMailbox({
      context,
      mailboxId: mailbox.data.id,
      searchBackend: "postgres",
    });
    expect(nativeSearch.ok).toBe(true);
    if (nativeSearch.ok) expect(nativeSearch.data.searchBackend).toBe("postgres");
    const automaticSearch = await updateMailbox({
      context,
      mailboxId: mailbox.data.id,
      searchBackend: "auto",
    });
    expect(automaticSearch.ok).toBe(true);
    if (automaticSearch.ok) expect(automaticSearch.data.searchBackend).toBe("auto");

    const scope = "a".repeat(64);
    const encryptedSecret = await encryptSecret({ kind: "password", password: "persistence-fixture-secret" });
    const [connection] = await sql<{ id: string }[]>`
      INSERT INTO mail.provider_connections (
        owner_mailbox_id, name, email, username, imap_host, imap_port, imap_tls_mode,
        smtp_host, smtp_port, smtp_tls_mode, secret_kind, encrypted_secret,
        authenticated_principal, capabilities, server_identity, last_verified_at
      ) VALUES (
        ${mailbox.data.id}::uuid, 'Fixture', 'sender@example.com', 'sender@example.com',
        'imap.example.com', 993, 'implicit', 'smtp.example.com', 587, 'starttls',
        'password', ${encryptedSecret}, 'sender@example.com', '{}'::jsonb, '{}'::jsonb, now()
      ) RETURNING id
    `;
    const [resource] = await sql<{ id: string }[]>`
      INSERT INTO mail.remote_resources (
        mailbox_id, remote_locator, server_identity, scope_fingerprint, status
      ) VALUES (${mailbox.data.id}::uuid, '{}'::jsonb, '{}'::jsonb, ${scope}, 'active')
      RETURNING id
    `;
    const [binding] = await sql<{ id: string }[]>`
      INSERT INTO mail.provider_bindings (
        remote_resource_id, connection_id, state, remote_locator, capabilities, rights,
        verification_evidence, verified_scope_fingerprint, last_verified_at
      ) VALUES (
        ${resource!.id}::uuid, ${connection!.id}::uuid, 'active', '{}'::jsonb, '{}'::jsonb,
        '{}'::jsonb, '{}'::jsonb, ${scope}, now()
      ) RETURNING id
    `;
    const [folder] = await sql<{ id: string; short_id: string }[]>`
      INSERT INTO mail.folders (short_id, remote_resource_id, stable_key, name, role, sync_status)
      VALUES (${newShortId()}, ${resource!.id}::uuid, 'inbox-fixture', 'Inbox', 'inbox', 'current')
      RETURNING id, short_id
    `;
    await sql`
      INSERT INTO mail.binding_folder_refs (
        binding_id, folder_id, remote_path, uid_validity, uid_next, effective_rights, last_verified_at
      ) VALUES (
        ${binding!.id}::uuid, ${folder!.id}::uuid, 'INBOX', 1, 2,
        ARRAY['read', 'write_flags', 'insert', 'move', 'delete_messages']::text[], now()
      )
    `;
    const [identity] = await sql<{ id: string; short_id: string }[]>`
      INSERT INTO mail.sender_identities (
        short_id, mailbox_id, label, display_name, from_address, automation_policy, is_default, status
      ) VALUES (${newShortId()}, ${mailbox.data.id}::uuid, 'Fixture Sender', 'Fixture Sender', 'sender@example.com', 'disabled', true, 'verified')
      RETURNING id, short_id
    `;
    await sql`
      INSERT INTO mail.sender_identity_bindings (
        sender_identity_id, binding_id, provider_principal, verified_at, saves_sent_automatically
      ) VALUES (${identity!.id}::uuid, ${binding!.id}::uuid, 'sender@example.com', now(), true)
    `;

    const [draftCountBeforeSeed] = await sql<{ count: number }[]>`
      SELECT COUNT(*)::int AS count
      FROM mail.drafts
      WHERE mailbox_id = ${mailbox.data.id}::uuid
    `;
    const preparedSeed = await prepareDraftSeed({
      context,
      mailboxId: mailbox.data.id,
      origin: {
        kind: "compose",
        input: {
          senderIdentityId: identity!.id,
          to: [],
          cc: [],
          bcc: [],
          subject: "",
          body: "",
          intent: "new",
          conversationId: null,
          sourceMessageId: null,
          includeSourceAttachments: false,
        },
      },
    });
    expect(preparedSeed.ok).toBe(true);
    if (!preparedSeed.ok) return;
    const [draftCountAfterSeed] = await sql<{ count: number }[]>`
      SELECT COUNT(*)::int AS count
      FROM mail.drafts
      WHERE mailbox_id = ${mailbox.data.id}::uuid
    `;
    expect(draftCountAfterSeed?.count).toBe(draftCountBeforeSeed?.count);

    const materializedSeed = await materializeDraftSeed({
      context,
      mailboxId: mailbox.data.id,
      input: {
        idempotencyKey: preparedSeed.data.id,
        origin: preparedSeed.data.origin,
        draft: { ...preparedSeed.data.content, body: "First meaningful edit" },
      },
    });
    expect(materializedSeed.ok).toBe(true);
    if (!materializedSeed.ok) return;

    const replayedMaterialization = await materializeDraftSeed({
      context,
      mailboxId: mailbox.data.id,
      input: {
        idempotencyKey: preparedSeed.data.id,
        origin: preparedSeed.data.origin,
        draft: { ...preparedSeed.data.content, body: "A later retry payload" },
      },
    });
    expect(replayedMaterialization.ok && replayedMaterialization.data.id).toBe(materializedSeed.data.id);
    const [draftCountAfterMaterialization] = await sql<{ count: number }[]>`
      SELECT COUNT(*)::int AS count
      FROM mail.drafts
      WHERE mailbox_id = ${mailbox.data.id}::uuid
    `;
    expect(draftCountAfterMaterialization?.count).toBe((draftCountBeforeSeed?.count ?? 0) + 1);

    const mailboxConnections = await listProviderConnections(context, mailbox.data.id);
    expect(mailboxConnections.ok).toBe(true);
    if (mailboxConnections.ok) expect(mailboxConnections.data.some((item) => item.id === connection!.id)).toBe(true);

    const initialExecution = await resolveMailExecution({
      context,
      mailboxId: mailbox.data.id,
      operation: "actorMutation",
      folderRequirements: [{ folderId: folder!.id, rights: ["write_flags"] }],
    });
    expect(initialExecution.ok).toBe(true);
    if (initialExecution.ok) expect(initialExecution.data.secretRevision).toBe(1);

    await sql.begin(async (tx) => {
      await tx`UPDATE mail.remote_resources SET status = 'degraded' WHERE id = ${resource!.id}::uuid`;
      await tx`UPDATE mail.provider_bindings SET state = 'degraded' WHERE id = ${binding!.id}::uuid`;
      await tx`UPDATE mail.provider_connections SET status = 'degraded' WHERE id = ${connection!.id}::uuid`;
      await tx`UPDATE mail.mailboxes SET health = 'degraded' WHERE id = ${mailbox.data.id}::uuid`;
    });
    const degradedExecution = await resolveMailExecution({
      context,
      mailboxId: mailbox.data.id,
      operation: "actorMutation",
      folderRequirements: [{ folderId: folder!.id, rights: ["write_flags"] }],
    });
    expect(degradedExecution.ok).toBe(true);

    await sql`UPDATE mail.mailboxes SET health = 'auth_required' WHERE id = ${mailbox.data.id}::uuid`;
    const authenticationRequiredExecution = await resolveMailExecution({
      context,
      mailboxId: mailbox.data.id,
      operation: "actorMutation",
      folderRequirements: [{ folderId: folder!.id, rights: ["write_flags"] }],
    });
    expect(authenticationRequiredExecution.ok).toBe(false);

    await sql.begin(async (tx) => {
      await tx`UPDATE mail.remote_resources SET status = 'active' WHERE id = ${resource!.id}::uuid`;
      await tx`UPDATE mail.provider_bindings SET state = 'active' WHERE id = ${binding!.id}::uuid`;
      await tx`UPDATE mail.provider_connections SET status = 'active' WHERE id = ${connection!.id}::uuid`;
      await tx`UPDATE mail.mailboxes SET health = 'active', health_reason = NULL WHERE id = ${mailbox.data.id}::uuid`;
    });
    await sql`UPDATE mail.provider_connections SET secret_revision = 2 WHERE id = ${connection!.id}::uuid`;
    const staleCredentialExecution = await resolveMailExecution({
      context,
      mailboxId: mailbox.data.id,
      operation: "actorMutation",
      folderRequirements: [{ folderId: folder!.id, rights: ["write_flags"] }],
    });
    expect(staleCredentialExecution.ok).toBe(false);
    await sql`UPDATE mail.provider_connections SET secret_revision = 1 WHERE id = ${connection!.id}::uuid`;

    const orderingEnvelope = (params: { uid: number; messageId: string; internalDate: Date; outbound: boolean }): ConnectorEnvelope => ({
      remoteRef: { folderStableKey: folder!.id, uidValidity: "1", uid: String(params.uid), modseq: null },
      providerMessageId: null,
      providerThreadId: null,
      messageId: params.messageId,
      inReplyTo: null,
      references: [],
      subject: params.outbound ? "Re: Ordering test" : "Ordering test",
      sentAt: params.internalDate,
      internalDate: params.internalDate,
      sizeBytes: 128,
      flags: [],
      labels: [],
      addresses: {
        from: [
          {
            name: params.outbound ? "Fixture Sender" : "Customer",
            address: params.outbound ? "sender@example.com" : "customer@example.com",
          },
        ],
        replyTo: [],
        to: [
          {
            name: params.outbound ? "Customer" : "Fixture Sender",
            address: params.outbound ? "customer@example.com" : "sender@example.com",
          },
        ],
        cc: [],
        bcc: [],
      },
      mimeStructure: {},
    });
    const hydrateOrderingMessage = async (messageId: string, envelope: ConnectorEnvelope) => {
      const from = envelope.addresses.from[0]!;
      const to = envelope.addresses.to[0]!;
      const source = Buffer.from(
        [
          `Message-ID: ${envelope.messageId}`,
          `Date: ${envelope.internalDate.toUTCString()}`,
          `From: ${from.name} <${from.address}>`,
          `To: ${to.name} <${to.address}>`,
          `Subject: ${envelope.subject}`,
          "Content-Type: text/plain; charset=utf-8",
          "",
          `Verified source for ${envelope.messageId}`,
        ].join("\r\n"),
      );
      await hydrateMessageFromSource({ messageId, source: Readable.from([source]) });
    };
    const latestInboundAt = new Date("2026-07-11T12:00:00.000Z");
    const latestInboundEnvelope = orderingEnvelope({
      uid: 10,
      messageId: "<ordering-inbound@example.com>",
      internalDate: latestInboundAt,
      outbound: false,
    });
    const latestInboundId = await ingestEnvelope({
      db: sql,
      mailboxId: mailbox.data.id,
      remoteResourceId: resource!.id,
      folderId: folder!.id,
      message: latestInboundEnvelope,
    });
    await hydrateOrderingMessage(latestInboundId, latestInboundEnvelope);
    const [conversationCountBeforeReplay] = await sql<{ count: number }[]>`
      SELECT COUNT(*)::int AS count FROM mail.conversations WHERE mailbox_id = ${mailbox.data.id}::uuid
    `;
    await ingestEnvelope({
      db: sql,
      mailboxId: mailbox.data.id,
      remoteResourceId: resource!.id,
      folderId: folder!.id,
      message: orderingEnvelope({ uid: 10, messageId: "<ordering-inbound@example.com>", internalDate: latestInboundAt, outbound: false }),
    });
    const [conversationReplay] = await sql<{ conversation_count: number; link_count: number }[]>`
      SELECT
        (SELECT COUNT(*)::int FROM mail.conversations WHERE mailbox_id = ${mailbox.data.id}::uuid) AS conversation_count,
        (SELECT COUNT(*)::int FROM mail.conversation_messages WHERE message_id = ${latestInboundId}::uuid) AS link_count
    `;
    expect(conversationReplay).toEqual({ conversation_count: conversationCountBeforeReplay!.count, link_count: 1 });
    const [copyFolder] = await sql<{ id: string; short_id: string }[]>`
      INSERT INTO mail.folders (short_id, remote_resource_id, stable_key, name, role, sync_status)
      VALUES (${newShortId()}, ${resource!.id}::uuid, 'copy-fixture', 'Copy target', 'other', 'current')
      RETURNING id, short_id
    `;
    const [projectedCopyRef] = await sql<{ id: string }[]>`
      INSERT INTO mail.remote_message_refs (folder_id, message_id, uid_validity, uid, connector_ref)
      VALUES (
        ${copyFolder!.id}::uuid,
        ${latestInboundId}::uuid,
        1,
        1,
        ${{ source: "command" }}::jsonb
      )
      RETURNING id
    `;
    await sql`
      INSERT INTO mail.message_placements (remote_message_ref_id, folder_id, message_id, flags, keywords)
      VALUES (
        ${projectedCopyRef!.id}::uuid,
        ${copyFolder!.id}::uuid,
        ${latestInboundId}::uuid,
        ARRAY[]::text[],
        ARRAY[]::text[]
      )
    `;
    const copiedMessageId = await ingestEnvelope({
      db: sql,
      mailboxId: mailbox.data.id,
      remoteResourceId: resource!.id,
      folderId: copyFolder!.id,
      message: {
        ...orderingEnvelope({ uid: 1, messageId: "<ordering-inbound@example.com>", internalDate: latestInboundAt, outbound: false }),
        remoteRef: { folderStableKey: copyFolder!.id, uidValidity: "1", uid: "1", modseq: "2" },
      },
    });
    expect(copiedMessageId).toBe(latestInboundId);
    const [copyProjection] = await sql<{ content_count: number; placement_count: number; link_count: number }[]>`
      SELECT
        (SELECT COUNT(*)::int FROM mail.message_contents WHERE mailbox_id = ${mailbox.data.id}::uuid AND lower(message_id) = '<ordering-inbound@example.com>') AS content_count,
        (SELECT COUNT(*)::int FROM mail.message_placements WHERE message_id = ${latestInboundId}::uuid AND deleted_at IS NULL) AS placement_count,
        (SELECT COUNT(*)::int FROM mail.conversation_messages WHERE message_id = ${latestInboundId}::uuid) AS link_count
    `;
    expect(copyProjection).toEqual({ content_count: 1, placement_count: 2, link_count: 1 });
    const olderOutboundEnvelope = orderingEnvelope({
      uid: 9,
      messageId: "<ordering-older-outbound@example.com>",
      internalDate: new Date("2026-07-11T11:00:00.000Z"),
      outbound: true,
    });
    const olderOutboundId = await ingestEnvelope({
      db: sql,
      mailboxId: mailbox.data.id,
      remoteResourceId: resource!.id,
      folderId: folder!.id,
      message: olderOutboundEnvelope,
    });
    await hydrateOrderingMessage(olderOutboundId, olderOutboundEnvelope);
    const [orderedConversation] = await sql<{ id: string; work_status: string; message_count: number }[]>`
      SELECT c.id, c.work_status, COUNT(cm.message_id)::int AS message_count
      FROM mail.conversations c
      JOIN mail.conversation_messages latest_link ON latest_link.conversation_id = c.id
      JOIN mail.conversation_messages cm ON cm.conversation_id = c.id
      WHERE latest_link.message_id = ${latestInboundId}::uuid
      GROUP BY c.id
    `;
    expect(orderedConversation).toMatchObject({ work_status: "needs_action", message_count: 2 });
    const newerOutboundEnvelope = orderingEnvelope({
      uid: 11,
      messageId: "<ordering-newer-outbound@example.com>",
      internalDate: new Date("2026-07-11T13:00:00.000Z"),
      outbound: true,
    });
    const newerOutboundId = await ingestEnvelope({
      db: sql,
      mailboxId: mailbox.data.id,
      remoteResourceId: resource!.id,
      folderId: folder!.id,
      message: newerOutboundEnvelope,
    });
    await hydrateOrderingMessage(newerOutboundId, newerOutboundEnvelope);
    const derivedRequest = {
      context,
      mailboxId: mailbox.data.id,
      messageId: newerOutboundId,
      input: {
        kind: "resend" as const,
        senderIdentityId: identity!.id,
        includeAttachments: true,
        idempotencyKey: `resend-${suffix}`,
      },
    };
    const resendDraft = await deriveDraftFromMessage(derivedRequest);
    expect(resendDraft.ok).toBe(true);
    if (!resendDraft.ok) return;
    expect(resendDraft.data).toMatchObject({
      conversationId: null,
      intent: "new",
      sourceMessageId: null,
      derivedFromMessageId: newerOutboundId,
      derivationKind: "resend",
      subject: newerOutboundEnvelope.subject,
      format: "plain",
    });
    const replayedResendDraft = await deriveDraftFromMessage(derivedRequest);
    expect(replayedResendDraft.ok && replayedResendDraft.data.id).toBe(resendDraft.data.id);
    const conflictingResend = await deriveDraftFromMessage({
      ...derivedRequest,
      input: { ...derivedRequest.input, includeAttachments: false },
    });
    expect(conflictingResend).toMatchObject({
      ok: false,
      error: { status: 409 },
    });
    const inboundResend = await deriveDraftFromMessage({
      context,
      mailboxId: mailbox.data.id,
      messageId: latestInboundId,
      input: {
        kind: "resend",
        senderIdentityId: identity!.id,
        includeAttachments: true,
        idempotencyKey: `inbound-resend-${suffix}`,
      },
    });
    expect(inboundResend).toMatchObject({
      ok: false,
      error: { status: 400 },
    });
    const safetyDraft = await createDraft({
      context,
      mailboxId: mailbox.data.id,
      input: {
        senderIdentityId: identity!.id,
        to: [{ name: "Customer", address: "customer@example.com" }],
        cc: [],
        bcc: [],
        subject: "Requested document",
        body: "Please see the attached document.",
        format: "plain",
      },
    });
    expect(safetyDraft.ok).toBe(true);
    if (!safetyDraft.ok) return;
    const unapprovedSafetySend = await createActorCommand({
      context,
      mailboxId: mailbox.data.id,
      input: {
        kind: "send",
        draftId: safetyDraft.data.id,
        expectedDraftRevision: safetyDraft.data.revision,
        senderIdentityId: identity!.id,
        undoSeconds: 60,
        idempotencyKey: `safety-unapproved-${suffix}`,
      },
    });
    expect(unapprovedSafetySend).toMatchObject({
      ok: false,
      error: { status: 409 },
    });
    const safetyReview = await reviewDraftComposeSafety({
      context,
      mailboxId: mailbox.data.id,
      draftId: safetyDraft.data.id,
      expectedRevision: safetyDraft.data.revision,
    });
    expect(safetyReview.ok).toBe(true);
    if (!safetyReview.ok) return;
    expect(safetyReview.data.warnings.map((warning) => warning.id)).toContain("missing_attachment");
    const revisedSafetyDraft = await updateDraft({
      context,
      mailboxId: mailbox.data.id,
      draftId: safetyDraft.data.id,
      expectedRevision: safetyDraft.data.revision,
      input: {
        senderIdentityId: identity!.id,
        to: safetyDraft.data.to,
        cc: safetyDraft.data.cc,
        bcc: safetyDraft.data.bcc,
        subject: safetyDraft.data.subject,
        body: `${safetyDraft.data.body}\n\nThank you.`,
        format: safetyDraft.data.format,
        priority: safetyDraft.data.priority,
        requestDeliveryReceipt: safetyDraft.data.requestDeliveryReceipt,
        requestReadReceipt: safetyDraft.data.requestReadReceipt,
      },
    });
    expect(revisedSafetyDraft.ok).toBe(true);
    if (!revisedSafetyDraft.ok) return;
    const staleSafetyApproval = await createActorCommand({
      context,
      mailboxId: mailbox.data.id,
      input: {
        kind: "send",
        draftId: revisedSafetyDraft.data.id,
        expectedDraftRevision: revisedSafetyDraft.data.revision,
        senderIdentityId: identity!.id,
        undoSeconds: 60,
        idempotencyKey: `safety-stale-${suffix}`,
        safetyApproval: {
          revision: safetyReview.data.revision,
          fingerprint: safetyReview.data.fingerprint,
          warningIds: safetyReview.data.warnings.map((warning) => warning.id),
        },
      },
    });
    expect(staleSafetyApproval).toMatchObject({
      ok: false,
      error: { status: 409 },
    });
    const revisedSafetyReview = await reviewDraftComposeSafety({
      context,
      mailboxId: mailbox.data.id,
      draftId: revisedSafetyDraft.data.id,
      expectedRevision: revisedSafetyDraft.data.revision,
    });
    expect(revisedSafetyReview.ok).toBe(true);
    if (!revisedSafetyReview.ok) return;
    const approvedSafetySend = await createActorCommand({
      context,
      mailboxId: mailbox.data.id,
      input: {
        kind: "send",
        draftId: revisedSafetyDraft.data.id,
        expectedDraftRevision: revisedSafetyDraft.data.revision,
        senderIdentityId: identity!.id,
        undoSeconds: 60,
        idempotencyKey: `safety-approved-${suffix}`,
        safetyApproval: {
          revision: revisedSafetyReview.data.revision,
          fingerprint: revisedSafetyReview.data.fingerprint,
          warningIds: revisedSafetyReview.data.warnings.map((warning) => warning.id),
        },
      },
    });
    expect(approvedSafetySend.ok, approvedSafetySend.ok ? undefined : JSON.stringify(approvedSafetySend.error)).toBe(true);
    const [answeredConversation] = await sql<{ work_status: string; message_count: number }[]>`
      SELECT c.work_status, COUNT(cm.message_id)::int AS message_count
      FROM mail.conversations c
      JOIN mail.conversation_messages cm ON cm.conversation_id = c.id
      WHERE c.id = ${orderedConversation!.id}::uuid
      GROUP BY c.id
    `;
    expect(answeredConversation).toEqual({ work_status: "needs_action", message_count: 3 });
    const latestMessagePage = await listConversationMessages({
      context,
      mailboxId: mailbox.data.id,
      conversationId: orderedConversation!.id,
      limit: 2,
      latest: true,
    });
    expect(latestMessagePage.ok).toBe(true);
    if (!latestMessagePage.ok) return;
    const expectedLatestMessages = await sql<{ message_id: string }[]>`
      SELECT cm.message_id
      FROM mail.conversation_messages cm
      JOIN mail.message_contents mc ON mc.id = cm.message_id
      WHERE cm.conversation_id = ${orderedConversation!.id}::uuid
      ORDER BY mc.internal_date DESC, cm.message_id DESC
      LIMIT 2
    `;
    expect(latestMessagePage.data.items.map((message) => message.id)).toEqual(
      expectedLatestMessages.map((message) => message.message_id).toReversed(),
    );
    expect(latestMessagePage.data.nextCursor).not.toBeNull();
    const unreadConversations = await listConversations({
      context,
      mailboxId: mailbox.data.id,
      limit: 100,
    });
    expect(unreadConversations.ok).toBe(true);
    if (!unreadConversations.ok) return;
    const unreadConversation = unreadConversations.data.items.find((item) => item.id === orderedConversation!.id);
    expect(unreadConversation?.unread).toBe(true);
    expect(Array.isArray(unreadConversation?.unreadFolderIds)).toBe(true);
    expect(unreadConversation?.unreadFolderIds).toContain(folder!.id);

    const filteredUnreadConversations = await listConversations({
      context,
      mailboxId: mailbox.data.id,
      unread: true,
      limit: 100,
    });
    expect(filteredUnreadConversations.ok).toBe(true);
    if (!filteredUnreadConversations.ok) return;
    expect(filteredUnreadConversations.data.items.length).toBeGreaterThan(0);
    expect(filteredUnreadConversations.data.items.every((item) => item.unread)).toBe(true);
    expect(filteredUnreadConversations.data.items.some((item) => item.id === orderedConversation!.id)).toBe(true);

    if (!unreadConversation) throw new Error("Expected the ordered conversation in the unread page");
    const capabilityTag = await createLocalTag({
      context,
      mailboxId: mailbox.data.id,
      input: { name: `Capability ${suffix}`, color: "#2563eb" },
    });
    if (!capabilityTag.ok) throw new Error(`${capabilityTag.error.code}: ${capabilityTag.error.message}`);
    expect(capabilityTag.ok).toBe(true);
    if (!capabilityTag.ok) return;
    const taggedConversation = await setConversationLocalTags({
      context,
      mailboxId: mailbox.data.id,
      conversationId: orderedConversation!.id,
      input: { expectedRevision: unreadConversation.revision, tagIds: [capabilityTag.data.id] },
    });
    if (!taggedConversation.ok) throw new Error(`${taggedConversation.error.code}: ${taggedConversation.error.message}`);
    expect(taggedConversation.ok).toBe(true);
    if (!taggedConversation.ok) return;
    const currentSummary = await getConversationSummary({
      context,
      mailboxId: mailbox.data.id,
      conversationId: orderedConversation!.id,
    });
    if (!currentSummary.ok) throw new Error(`${currentSummary.error.code}: ${currentSummary.error.message}`);
    const updatedSummary = await updateConversationSummary({
      context,
      mailboxId: mailbox.data.id,
      conversationId: orderedConversation!.id,
      input: {
        expectedSummaryRevision: currentSummary.data.summaryRevision,
        summary: "The latest reply confirms the plan and leaves one follow-up.",
      },
    });
    if (!updatedSummary.ok) throw new Error(`${updatedSummary.error.code}: ${updatedSummary.error.message}`);

    const capabilityResult = await (async (orderedConversation: { id: string }) => {
      const conversationCapability = mailCapabilities.queries["conversation.read"];
      return conversationCapability.run(
        { id: orderedConversation.id },
        {
          actor: context.actor,
          accessSubject: context.accessSubject,
          user: context.actor.kind === "user" ? context.actor.user : context.actor.delegatedUser,
          locale: "en",
          signal: AbortSignal.timeout(10_000),
        },
      );
    })({ id: await publicConversationId(orderedConversation!.id) });
    expect(capabilityResult.ok).toBe(true);
    if (!capabilityResult.ok) return;
    expect(ConversationGetDataSchema.safeParse(capabilityResult.data.data).success).toBe(true);
    expect(capabilityResult.data.data.summary).toBe("The latest reply confirms the plan and leaves one follow-up.");
    expect(capabilityResult.data.data.summaryRevision).toBe(updatedSummary.data.summaryRevision);
    expect(capabilityResult.data.data.tags).toEqual([
      {
        id: await publicTagId(capabilityTag.data.id),
        name: capabilityTag.data.name,
        color: capabilityTag.data.color,
        revision: capabilityTag.data.revision,
      },
    ]);

    const liveAbort = new AbortController();
    const liveCursor = (await latestMailInvalidationCursor(mailbox.data.id)) ?? "0-0";
    const liveIterator = liveMailInvalidations({ mailboxId: mailbox.data.id, after: liveCursor, signal: liveAbort.signal })[
      Symbol.asyncIterator
    ]();
    const nextLiveInvalidation = liveIterator.next();
    const conversationRead = await createConversationTriageCommands({
      context,
      mailboxId: mailbox.data.id,
      conversationId: orderedConversation!.id,
      input: {
        kind: "change_state",
        sourceFolderId: folder!.id,
        change: { addFlags: ["seen"], removeFlags: [], addKeywords: [], removeKeywords: [] },
        idempotencyKey: `conversation-read-${suffix}`,
      },
    });
    expect(conversationRead.ok).toBe(true);
    if (!conversationRead.ok) return;
    const liveInvalidation = await Promise.race([
      nextLiveInvalidation,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Timed out waiting for triage invalidation")), 5_000)),
    ]);
    liveAbort.abort();
    expect(liveInvalidation.value?.data).toMatchObject({
      type: "mail.invalidated",
      mailboxId: await publicMailboxId(mailbox.data.id),
      conversationId: null,
      changeId: expect.any(String),
    });
    expect(conversationRead.data.commands).toHaveLength(3);
    expect(new Set(conversationRead.data.commands.map((item) => item.correlationId))).toEqual(
      new Set([conversationRead.data.correlationId]),
    );
    const [localReadProjection] = await sql<{ messages: number; read_messages: number }[]>`
      SELECT
        COUNT(*)::int AS messages,
        COUNT(*) FILTER (WHERE '\\Seen' = ANY(placement.flags))::int AS read_messages
      FROM mail.conversation_messages conversation_message
      JOIN mail.remote_message_refs ref ON ref.message_id = conversation_message.message_id
      JOIN mail.message_placements placement ON placement.remote_message_ref_id = ref.id
      WHERE conversation_message.conversation_id = ${orderedConversation!.id}::uuid
        AND ref.folder_id = ${folder!.id}::uuid
        AND ref.stale_at IS NULL
        AND placement.deleted_at IS NULL
    `;
    expect(localReadProjection).toEqual({ messages: 3, read_messages: 3 });
    const replayedConversationRead = await createConversationTriageCommands({
      context,
      mailboxId: mailbox.data.id,
      conversationId: orderedConversation!.id,
      input: {
        kind: "change_state",
        sourceFolderId: folder!.id,
        change: { addFlags: ["seen"], removeFlags: [], addKeywords: [], removeKeywords: [] },
        idempotencyKey: `conversation-read-${suffix}`,
      },
    });
    expect(replayedConversationRead.ok).toBe(true);
    if (replayedConversationRead.ok) {
      expect(replayedConversationRead.data.commands.map((item) => item.id)).toEqual(conversationRead.data.commands.map((item) => item.id));
    }

    const replyDraft = await createDraft({
      context,
      mailboxId: mailbox.data.id,
      input: {
        conversationId: orderedConversation!.id,
        intent: "reply",
        sourceMessageId: latestInboundId,
        senderIdentityId: identity!.id,
        to: [{ name: "Untrusted client value", address: "wrong@example.com" }],
        cc: [],
        bcc: [],
        subject: "Re: Ordered newest inbound",
        body: "Reply using the pinned source message",
        format: "plain",
      },
    });
    expect(replyDraft.ok).toBe(true);
    if (!replyDraft.ok) return;
    expect(replyDraft.data.intent).toBe("reply");
    expect(replyDraft.data.sourceMessageId).toBe(latestInboundId);
    expect(replyDraft.data.to).toEqual([{ name: "Customer", address: "customer@example.com" }]);
    const editedReplyDraft = await updateDraft({
      context,
      mailboxId: mailbox.data.id,
      draftId: replyDraft.data.id,
      expectedRevision: replyDraft.data.revision,
      input: {
        senderIdentityId: identity!.id,
        to: [{ name: "Recipient", address: "recipient@example.com" }],
        cc: [],
        bcc: [],
        subject: "Re: Ordered newest inbound",
        body: "Edited reply content",
        format: "plain",
      },
    });
    expect(editedReplyDraft.ok).toBe(true);
    if (!editedReplyDraft.ok) return;
    expect(editedReplyDraft.data.sourceMessageId).toBe(latestInboundId);
    const conversationDrafts = await listConversationDrafts({
      context,
      mailboxId: mailbox.data.id,
      conversationId: orderedConversation!.id,
    });
    expect(conversationDrafts.ok).toBe(true);
    if (conversationDrafts.ok) {
      expect(conversationDrafts.data).toContainEqual({
        id: replyDraft.data.id,
        intent: "reply",
        subject: "Re: Ordered newest inbound",
        bodyPreview: "Edited reply content",
        createdByDisplayName: "Mail Integration Test",
        updatedAt: editedReplyDraft.data.updatedAt,
      });
      expect(conversationDrafts.data[0]).not.toHaveProperty("body");
    }
    const replyCommand = await createActorCommand({
      context,
      mailboxId: mailbox.data.id,
      input: {
        kind: "send",
        draftId: replyDraft.data.id,
        expectedDraftRevision: editedReplyDraft.data.revision,
        senderIdentityId: identity!.id,
        undoSeconds: 60,
        idempotencyKey: `reply-source-send-${suffix}`,
      },
    });
    expect(replyCommand).toEqual(expect.objectContaining({ ok: true }));
    if (!replyCommand.ok) return;
    const scheduledConversationDrafts = await listConversationDrafts({
      context,
      mailboxId: mailbox.data.id,
      conversationId: orderedConversation!.id,
    });
    expect(scheduledConversationDrafts.ok).toBe(true);
    if (scheduledConversationDrafts.ok) {
      expect(scheduledConversationDrafts.data.map((draft) => draft.id)).not.toContain(replyDraft.data.id);
    }
    const [replyOutbox] = await sql<
      { id: string; message_id: string; stable_message_id: string; draft_snapshot: Record<string, unknown> | string }[]
    >`
      SELECT id, message_id, stable_message_id, draft_snapshot
      FROM mail.outbox_submissions
      WHERE command_id = ${replyCommand.data.id}::uuid
    `;
    const replySnapshot =
      typeof replyOutbox?.draft_snapshot === "string" ? JSON.parse(replyOutbox.draft_snapshot) : replyOutbox?.draft_snapshot;
    expect(replySnapshot?.inReplyTo).toBe("<ordering-inbound@example.com>");
    expect(replySnapshot?.references).toContain("<ordering-inbound@example.com>");
    expect(replyCommand.data.result).toMatchObject({
      outboxSubmissionId: replyOutbox!.id,
      outboundMessageId: replyOutbox!.message_id,
      conversationId: orderedConversation!.id,
    });
    const [projectedReply] = await sql<
      {
        hydration_status: string;
        plain_text: string | null;
        conversation_id: string;
        address_count: number;
      }[]
    >`
      SELECT
        message.hydration_status,
        message.plain_text,
        link.conversation_id,
        (
          SELECT COUNT(*)::int
          FROM mail.message_addresses address
          WHERE address.message_id = message.id
        ) AS address_count
      FROM mail.message_contents message
      JOIN mail.conversation_messages link ON link.message_id = message.id
      WHERE message.id = ${replyOutbox!.message_id}::uuid
    `;
    expect(projectedReply).toEqual({
      hydration_status: "body",
      plain_text: "Edited reply content",
      conversation_id: orderedConversation!.id,
      address_count: 2,
    });
    const projectedReplyDetail = await getMessage({
      context,
      mailboxId: mailbox.data.id,
      messageId: replyOutbox!.message_id,
    });
    expect(projectedReplyDetail.ok).toBe(true);
    if (projectedReplyDetail.ok) {
      expect(projectedReplyDetail.data).toMatchObject({
        plainText: "Edited reply content",
        hydrationStatus: "body",
        delivery: {
          submissionId: replyOutbox!.id,
          draftId: replyDraft.data.id,
          state: "undo_window",
          attempt: 0,
          maxAttempts: 5,
          acceptedRecipients: [],
          rejectedRecipients: [],
        },
      });
    }
    await sql`
      UPDATE mail.outbox_submissions
      SET state = 'scheduled', undo_until = NULL, last_error_code = 'SMTP_TRANSIENT_REJECTION', last_error_message = 'Temporary rejection'
      WHERE id = ${replyOutbox!.id}::uuid
    `;
    const problemCounts = await getConversationViewCounts({ context, mailboxId: mailbox.data.id });
    expect(problemCounts.ok).toBe(true);
    if (problemCounts.ok) expect(problemCounts.data.send_problems).toBeGreaterThan(0);
    const problemConversations = await listConversations({ context, mailboxId: mailbox.data.id, view: "send_problems" });
    expect(problemConversations.ok).toBe(true);
    if (problemConversations.ok) {
      expect(problemConversations.data.items.map((conversation) => conversation.id)).toContain(orderedConversation!.id);
    }
    await sql`
      UPDATE mail.outbox_submissions
      SET state = 'undo_window', undo_until = scheduled_at, last_error_code = NULL, last_error_message = NULL
      WHERE id = ${replyOutbox!.id}::uuid
    `;
    const [reportMessage] = await sql<{ id: string }[]>`
      INSERT INTO mail.message_contents (
        short_id, mailbox_id, message_id, internal_date, content_hash, hydration_status
      ) VALUES (
        ${newShortId()},
        ${mailbox.data.id}::uuid,
        ${`<delivery-report-${suffix}@example.com>`},
        now(),
        ${"f".repeat(64)},
        'complete'
      )
      RETURNING id
    `;
    if (!reportMessage || !replyOutbox) throw new Error("Receipt test fixtures were not created");
    const recordedReceipt = await sql.begin((tx) =>
      recordMessageReceipt({
        db: tx,
        mailboxId: mailbox.data.id,
        reportMessageId: reportMessage.id,
        receipt: {
          kind: "delivery",
          status: "delivered",
          originalEnvelopeId: replyOutbox.id,
          originalMessageId: replyOutbox.stable_message_id.replace(/^<|>$/gu, "").toLowerCase(),
        },
      }),
    );
    expect(recordedReceipt).toMatchObject({
      mailboxId: mailbox.data.id,
      conversationId: orderedConversation!.id,
      reason: "outbound",
      targetId: reportMessage.id,
    });
    const replayedReceipt = await sql.begin((tx) =>
      recordMessageReceipt({
        db: tx,
        mailboxId: mailbox.data.id,
        reportMessageId: reportMessage.id,
        receipt: {
          kind: "delivery",
          status: "delivered",
          originalEnvelopeId: replyOutbox.id,
          originalMessageId: replyOutbox.stable_message_id.replace(/^<|>$/gu, "").toLowerCase(),
        },
      }),
    );
    expect(replayedReceipt).toBeNull();
    const [storedReceipt] = await sql<{ reports: number; activities: number }[]>`
      SELECT
        (SELECT COUNT(*)::int FROM mail.message_receipt_reports WHERE report_message_id = ${reportMessage.id}::uuid) AS reports,
        (
          SELECT COUNT(*)::int
          FROM mail.activity_events
          WHERE target_id = ${reportMessage.id}::uuid
            AND action = 'message.delivery_receipt_received'
        ) AS activities
    `;
    expect(storedReceipt).toEqual({ reports: 1, activities: 1 });
    const rejectedPostSendAutosave = await updateDraft({
      context,
      mailboxId: mailbox.data.id,
      draftId: replyDraft.data.id,
      expectedRevision: editedReplyDraft.data.revision,
      input: {
        senderIdentityId: identity!.id,
        to: [{ name: "Recipient", address: "recipient@example.com" }],
        cc: [],
        bcc: [],
        subject: "Re: Ordered newest inbound",
        body: "Typing that arrived after scheduling",
        format: "plain",
      },
    });
    expect(rejectedPostSendAutosave.ok).toBe(false);
    const postSendRecovery = await listDraftRecoveryCopies({
      context,
      mailboxId: mailbox.data.id,
      draftId: replyDraft.data.id,
    });
    expect(postSendRecovery.ok && postSendRecovery.data.filter((copy) => copy.restoredAt === null)).toHaveLength(1);
    if (postSendRecovery.ok) expect(postSendRecovery.data[0]?.content.body).toBe("Typing that arrived after scheduling");
    const reconciledReplyId = await ingestEnvelope({
      db: sql,
      mailboxId: mailbox.data.id,
      remoteResourceId: resource!.id,
      folderId: folder!.id,
      message: {
        ...orderingEnvelope({
          uid: 12,
          messageId: replyOutbox!.stable_message_id,
          internalDate: new Date(),
          outbound: true,
        }),
        messageId: replyOutbox!.stable_message_id,
        inReplyTo: "<ordering-inbound@example.com>",
        references: ["<ordering-inbound@example.com>"],
        subject: "Re: Ordered newest inbound",
        addresses: {
          from: [{ name: "Fixture Sender", address: "sender@example.com" }],
          replyTo: [],
          to: [{ name: "Recipient", address: "recipient@example.com" }],
          cc: [],
          bcc: [],
        },
      },
    });
    expect(reconciledReplyId).toBe(replyOutbox!.message_id);
    const [reconciledProjection] = await sql<{ content_count: number; remote_ref_count: number; hydration_status: string }[]>`
      SELECT
        (
          SELECT COUNT(*)::int
          FROM mail.message_contents
          WHERE mailbox_id = ${mailbox.data.id}::uuid
            AND lower(message_id) = lower(${replyOutbox!.stable_message_id})
        ) AS content_count,
        (
          SELECT COUNT(*)::int
          FROM mail.remote_message_refs
          WHERE message_id = ${replyOutbox!.message_id}::uuid
        ) AS remote_ref_count,
        hydration_status
      FROM mail.message_contents
      WHERE id = ${replyOutbox!.message_id}::uuid
    `;
    expect(reconciledProjection).toEqual({ content_count: 1, remote_ref_count: 1, hydration_status: "body" });
    await sql`
      DELETE FROM mail.remote_message_refs
      WHERE message_id = ${replyOutbox!.message_id}::uuid
        AND folder_id = ${folder!.id}::uuid
        AND uid_validity = 1
        AND uid = 12
    `;
    expect((await cancelSendCommand({ context, mailboxId: mailbox.data.id, commandId: replyCommand.data.id })).ok).toBe(true);
    const [cancelledReplyProjection] = await sql<{ message_count: number }[]>`
      SELECT COUNT(*)::int AS message_count
      FROM mail.message_contents
      WHERE id = ${replyOutbox!.message_id}::uuid
    `;
    expect(cancelledReplyProjection?.message_count).toBe(0);
    const discardedReply = await discardDraft({
      context,
      mailboxId: mailbox.data.id,
      draftId: replyDraft.data.id,
      expectedRevision: editedReplyDraft.data.revision + 1,
    });
    expect(discardedReply.ok).toBe(true);

    const emptyDraft = await createDraft({
      context,
      mailboxId: mailbox.data.id,
      input: {
        senderIdentityId: identity!.id,
        to: [],
        cc: [],
        bcc: [],
        subject: "Integration subject",
        body: "Integration searchable body",
        format: "markdown",
      },
    });
    if (!emptyDraft.ok) throw new Error(`${emptyDraft.error.code}: ${emptyDraft.error.message}`);
    const lease = await acquireDraftLease({ context, mailboxId: mailbox.data.id, draftId: emptyDraft.data.id });
    expect(lease.ok).toBe(true);
    if (!lease.ok) return;
    expect((await acquireDraftLease({ context, mailboxId: mailbox.data.id, draftId: emptyDraft.data.id })).ok).toBe(false);
    expect(
      (
        await heartbeatDraftLease({
          context,
          mailboxId: mailbox.data.id,
          draftId: emptyDraft.data.id,
          token: crypto.randomUUID(),
        })
      ).ok,
    ).toBe(false);
    expect(
      (
        await heartbeatDraftLease({
          context,
          mailboxId: mailbox.data.id,
          draftId: emptyDraft.data.id,
          token: lease.data.token,
        })
      ).ok,
    ).toBe(true);
    expect(
      (
        await releaseDraftLease({
          context,
          mailboxId: mailbox.data.id,
          draftId: emptyDraft.data.id,
          token: lease.data.token,
        })
      ).ok,
    ).toBe(true);
    const emptySend = await createActorCommand({
      context,
      mailboxId: mailbox.data.id,
      input: {
        kind: "send",
        draftId: emptyDraft.data.id,
        expectedDraftRevision: emptyDraft.data.revision,
        senderIdentityId: identity!.id,
        undoSeconds: 60,
        idempotencyKey: `empty-send-${suffix}`,
      },
    });
    expect(emptySend.ok).toBe(false);
    const [emptyCommandCount] = await sql<{ count: number }[]>`
      SELECT COUNT(*)::int AS count
      FROM mail.commands
      WHERE mailbox_id = ${mailbox.data.id}::uuid AND idempotency_key = ${`empty-send-${suffix}`}
    `;
    expect(emptyCommandCount?.count).toBe(0);

    const invalidIdentityDraft = await createDraft({
      context,
      mailboxId: mailbox.data.id,
      input: {
        senderIdentityId: identity!.id,
        to: [{ name: "Recipient", address: "recipient@example.com" }],
        cc: [],
        bcc: [],
        subject: "Identity recovery",
        body: "Original body",
        format: "plain",
      },
    });
    expect(invalidIdentityDraft.ok).toBe(true);
    if (!invalidIdentityDraft.ok) return;
    const rejectedIdentityUpdate = await updateDraft({
      context,
      mailboxId: mailbox.data.id,
      draftId: invalidIdentityDraft.data.id,
      expectedRevision: invalidIdentityDraft.data.revision,
      input: {
        senderIdentityId: crypto.randomUUID(),
        to: [{ name: "Recipient", address: "recipient@example.com" }],
        cc: [],
        bcc: [],
        subject: "Identity recovery",
        body: "Unsaved body after identity removal",
        format: "plain",
      },
    });
    expect(rejectedIdentityUpdate.ok).toBe(false);
    const identityRecoveryCopies = await listDraftRecoveryCopies({
      context,
      mailboxId: mailbox.data.id,
      draftId: invalidIdentityDraft.data.id,
    });
    expect(identityRecoveryCopies.ok && identityRecoveryCopies.data).toHaveLength(1);
    if (identityRecoveryCopies.ok) {
      expect(identityRecoveryCopies.data[0]?.content.body).toBe("Unsaved body after identity removal");
    }
    const pendingUpload = await createDraftAttachmentUpload({
      context,
      mailboxId: mailbox.data.id,
      draftId: invalidIdentityDraft.data.id,
      input: { filename: "pending.txt", contentType: "text/plain", byteLength: 1 },
    });
    expect(pendingUpload.ok).toBe(true);
    if (!pendingUpload.ok) return;
    const sendWithPendingUpload = await createActorCommand({
      context,
      mailboxId: mailbox.data.id,
      input: {
        kind: "send",
        draftId: invalidIdentityDraft.data.id,
        expectedDraftRevision: invalidIdentityDraft.data.revision,
        senderIdentityId: identity!.id,
        undoSeconds: 60,
        idempotencyKey: `pending-upload-send-${suffix}`,
      },
    });
    expect(sendWithPendingUpload.ok).toBe(false);
    if (!sendWithPendingUpload.ok) expect(sendWithPendingUpload.error.code).toBe("CONFLICT");
    const cancelledUpload = await cancelDraftAttachmentUpload({
      context,
      mailboxId: mailbox.data.id,
      draftId: invalidIdentityDraft.data.id,
      uploadId: pendingUpload.data.id,
    });
    expect(cancelledUpload.ok && cancelledUpload.data.state).toBe("cancelled");
    const repeatedCancellation = await cancelDraftAttachmentUpload({
      context,
      mailboxId: mailbox.data.id,
      draftId: invalidIdentityDraft.data.id,
      uploadId: pendingUpload.data.id,
    });
    expect(repeatedCancellation.ok && repeatedCancellation.data.state).toBe("cancelled");
    const retainedCancellation = await getDraftAttachmentUpload({
      context,
      mailboxId: mailbox.data.id,
      draftId: invalidIdentityDraft.data.id,
      uploadId: pendingUpload.data.id,
    });
    expect(retainedCancellation.ok && retainedCancellation.data.state).toBe("cancelled");

    const draft = await updateDraft({
      context,
      mailboxId: mailbox.data.id,
      draftId: emptyDraft.data.id,
      expectedRevision: emptyDraft.data.revision,
      input: {
        senderIdentityId: identity!.id,
        to: [{ name: "Recipient", address: "recipient@example.com" }],
        cc: [],
        bcc: [],
        subject: "Integration subject",
        body: "Integration searchable body",
        format: "markdown",
      },
    });
    expect(draft.ok).toBe(true);
    if (!draft.ok) return;
    const draftActivity = await sql<{ action: string; revision: number }[]>`
      SELECT action, (metadata->>'revision')::int AS revision
      FROM mail.activity_events
      WHERE target_type = 'draft' AND target_id = ${draft.data.id}::uuid
      ORDER BY id
    `;
    expect(draftActivity).toEqual([{ action: "draft.created", revision: 1 }]);
    const staleUpdate = await updateDraft({
      context,
      mailboxId: mailbox.data.id,
      draftId: draft.data.id,
      expectedRevision: emptyDraft.data.revision,
      input: {
        senderIdentityId: identity!.id,
        to: [{ name: "Recipient", address: "recipient@example.com" }],
        cc: [],
        bcc: [],
        subject: "Integration subject",
        body: "Recovered stale body",
        format: "markdown",
      },
    });
    expect(staleUpdate.ok).toBe(false);
    const recoveryCopies = await listDraftRecoveryCopies({
      context,
      mailboxId: mailbox.data.id,
      draftId: draft.data.id,
    });
    expect(recoveryCopies.ok && recoveryCopies.data).toHaveLength(1);
    if (!recoveryCopies.ok || !recoveryCopies.data[0]) return;
    const recoveryLease = await acquireDraftLease({ context, mailboxId: mailbox.data.id, draftId: draft.data.id });
    expect(recoveryLease.ok).toBe(true);
    if (!recoveryLease.ok) return;
    const restoreWithoutLease = await restoreDraftRecoveryCopy({
      context,
      mailboxId: mailbox.data.id,
      draftId: draft.data.id,
      recoveryCopyId: recoveryCopies.data[0].id,
      expectedRevision: draft.data.revision,
      leaseToken: crypto.randomUUID(),
    });
    expect(restoreWithoutLease.ok).toBe(false);
    const restoredDraft = await restoreDraftRecoveryCopy({
      context,
      mailboxId: mailbox.data.id,
      draftId: draft.data.id,
      recoveryCopyId: recoveryCopies.data[0].id,
      expectedRevision: draft.data.revision,
      leaseToken: recoveryLease.data.token,
    });
    expect(restoredDraft.ok && restoredDraft.data.body).toBe("Recovered stale body");
    expect(restoredDraft.ok && restoredDraft.data.recoveryCopyCount).toBe(0);
    if (!restoredDraft.ok) return;
    const outgoingAttachment = Buffer.from(`outgoing attachment ${suffix}`);
    const draftWithAttachment = await uploadDraftAttachmentStream({
      context,
      mailboxId: mailbox.data.id,
      draftId: draft.data.id,
      expectedRevision: restoredDraft.data.revision,
      filename: "integration.txt",
      contentType: "text/plain",
      byteLength: outgoingAttachment.length,
      stream: Readable.from([outgoingAttachment]),
    });
    expect(draftWithAttachment.ok, draftWithAttachment.ok ? undefined : JSON.stringify(draftWithAttachment.error)).toBe(true);
    if (!draftWithAttachment.ok) return;
    expect(draftWithAttachment.data.attachments).toHaveLength(1);
    const [outgoingAttachmentBlob] = await sql<{ blob_id: string }[]>`
      SELECT blob_id
      FROM mail.draft_attachments
      WHERE id = ${draftWithAttachment.data.attachments[0]!.id}::uuid
    `;
    ids.blobIds.push(outgoingAttachmentBlob!.blob_id);
    const staleSend = await createActorCommand({
      context,
      mailboxId: mailbox.data.id,
      input: {
        kind: "send",
        draftId: draft.data.id,
        expectedDraftRevision: restoredDraft.data.revision,
        senderIdentityId: identity!.id,
        undoSeconds: 60,
        idempotencyKey: `stale-send-${suffix}`,
      },
    });
    expect(staleSend.ok).toBe(false);
    const command = await createActorCommand({
      context,
      mailboxId: mailbox.data.id,
      input: {
        kind: "send",
        draftId: draft.data.id,
        expectedDraftRevision: draftWithAttachment.data.revision,
        senderIdentityId: identity!.id,
        undoSeconds: 60,
        idempotencyKey: `send-${suffix}`,
      },
    });
    expect(command.ok).toBe(true);
    if (!command.ok) return;
    const [pinnedRevision] = await sql<{ selected_secret_revision: number }[]>`
      SELECT selected_secret_revision FROM mail.commands WHERE id = ${command.data.id}::uuid
    `;
    expect(pinnedRevision?.selected_secret_revision).toBe(1);
    const repeatedCommand = await createActorCommand({
      context,
      mailboxId: mailbox.data.id,
      input: {
        kind: "send",
        draftId: draft.data.id,
        expectedDraftRevision: draftWithAttachment.data.revision,
        senderIdentityId: identity!.id,
        undoSeconds: 60,
        idempotencyKey: `send-${suffix}`,
      },
    });
    expect(repeatedCommand.ok && repeatedCommand.data.id).toBe(command.data.id);
    const duplicateSend = await createActorCommand({
      context,
      mailboxId: mailbox.data.id,
      input: {
        kind: "send",
        draftId: draft.data.id,
        expectedDraftRevision: draftWithAttachment.data.revision,
        senderIdentityId: identity!.id,
        undoSeconds: 60,
        idempotencyKey: `duplicate-send-${suffix}`,
      },
    });
    expect(duplicateSend.ok).toBe(false);
    const conflictingCommand = await createActorCommand({
      context,
      mailboxId: mailbox.data.id,
      input: {
        kind: "send",
        draftId: draft.data.id,
        expectedDraftRevision: draftWithAttachment.data.revision,
        senderIdentityId: identity!.id,
        undoSeconds: 59,
        idempotencyKey: `send-${suffix}`,
      },
    });
    expect(conflictingCommand.ok).toBe(false);
    const [outbox] = await sql<
      {
        id: string;
        message_id: string;
        draft_snapshot: Record<string, unknown> | string;
        state: string;
        requested_at: Date;
        scheduled_at: Date;
        undo_until: Date;
        mime_date: Date;
        preflight_byte_length: string | number;
      }[]
    >`
      SELECT id, message_id, draft_snapshot, state, requested_at, scheduled_at, undo_until, mime_date, preflight_byte_length
      FROM mail.outbox_submissions
      WHERE command_id = ${command.data.id}::uuid
    `;
    expect(outbox?.state).toBe("undo_window");
    expect(outbox!.undo_until.getTime() - outbox!.requested_at.getTime()).toBe(60_000);
    expect(outbox!.scheduled_at.getTime() - outbox!.undo_until.getTime()).toBe(10_000);
    expect(outbox?.mime_date).toBeInstanceOf(Date);
    expect(Number(outbox?.preflight_byte_length)).toBeGreaterThan(outgoingAttachment.length);
    const snapshot = typeof outbox?.draft_snapshot === "string" ? JSON.parse(outbox.draft_snapshot) : outbox?.draft_snapshot;
    expect(snapshot?.subject).toBe("Integration subject");
    expect(snapshot?.attachments).toEqual([
      expect.objectContaining({
        id: draftWithAttachment.data.attachments[0]!.id,
        blobId: outgoingAttachmentBlob!.blob_id,
        filename: "integration.txt",
        byteLength: outgoingAttachment.length,
      }),
    ]);
    expect(command.data.result).toMatchObject({
      outboxSubmissionId: outbox!.id,
      outboundMessageId: outbox!.message_id,
    });
    const [projectedMessage] = await sql<
      {
        hydration_status: string;
        plain_text: string | null;
        attachment_count: number;
        attachment_blob_id: string | null;
      }[]
    >`
      SELECT
        message.hydration_status,
        message.plain_text,
        COUNT(attachment.id)::int AS attachment_count,
        MIN(attachment.blob_id::text) AS attachment_blob_id
      FROM mail.message_contents message
      LEFT JOIN mail.attachments attachment ON attachment.message_id = message.id
      WHERE message.id = ${outbox!.message_id}::uuid
      GROUP BY message.id
    `;
    expect(projectedMessage).toEqual({
      hydration_status: "body",
      plain_text: typeof snapshot?.renderedText === "string" ? snapshot.renderedText : snapshot?.body,
      attachment_count: 1,
      attachment_blob_id: outgoingAttachmentBlob!.blob_id,
    });
    const projectedConversationId = command.data.result.conversationId;
    expect(typeof projectedConversationId).toBe("string");
    if (typeof projectedConversationId !== "string") throw new Error("Send command is missing its conversation ID");
    const projectedConversationList = await listConversations({ context, mailboxId: mailbox.data.id, limit: 100 });
    expect(projectedConversationList.ok).toBe(true);
    let projectedConversationDbId: string | null = null;
    if (projectedConversationList.ok) {
      const conversationIds = projectedConversationList.data.items.map((item) => item.id);
      expect(conversationIds).toContain(projectedConversationId);
      projectedConversationDbId = projectedConversationList.data.items[conversationIds.indexOf(projectedConversationId)]?.id ?? null;
    }
    const cancelled = await cancelSendCommand({ context, mailboxId: mailbox.data.id, commandId: command.data.id });
    expect(cancelled.ok).toBe(true);
    const [restoredDraftProjection] = await sql<{ state: string; revision: number; projection_queued: boolean }[]>`
      SELECT
        draft.state,
        draft.revision::int,
        EXISTS (
          SELECT 1
          FROM mail.draft_provider_snapshots snapshot
          WHERE snapshot.draft_id = draft.id
            AND snapshot.direction = 'export'
            AND snapshot.cloud_revision = draft.revision
        ) AS projection_queued
      FROM mail.drafts draft
      WHERE draft.id = ${draft.data.id}::uuid
    `;
    expect(restoredDraftProjection).toEqual({
      state: "draft",
      revision: draftWithAttachment.data.revision + 1,
      projection_queued: true,
    });
    const restoredLease = await acquireDraftLease({
      context,
      mailboxId: mailbox.data.id,
      draftId: draft.data.id,
    });
    expect(restoredLease.ok).toBe(true);
    if (restoredLease.ok) {
      expect(
        (
          await releaseDraftLease({
            context,
            mailboxId: mailbox.data.id,
            draftId: draft.data.id,
            token: restoredLease.data.token,
          })
        ).ok,
      ).toBe(true);
    }
    const [cancelledProjection] = await sql<{ message_count: number; conversation_count: number }[]>`
      SELECT
        (SELECT COUNT(*)::int FROM mail.message_contents WHERE id = ${outbox!.message_id}::uuid) AS message_count,
        (
          SELECT COUNT(*)::int
          FROM mail.conversations
          WHERE id = ${projectedConversationDbId}::uuid
        ) AS conversation_count
    `;
    expect(cancelledProjection).toEqual({ message_count: 0, conversation_count: 0 });
    await sql`
      UPDATE mail.provider_connections
      SET limit_snapshot = ${{
        checkedAt: new Date().toISOString(),
        imap: { status: "unsupported", storage: null, messages: null },
        smtp: { status: "supported", maxMessageBytes: 1 },
      }}::jsonb
      WHERE id = ${connection!.id}::uuid
    `;
    const oversizedDraft = await createDraft({
      context,
      mailboxId: mailbox.data.id,
      input: {
        senderIdentityId: identity!.id,
        to: [{ name: "Recipient", address: "recipient@example.com" }],
        cc: [],
        bcc: [],
        subject: "Provider limit",
        body: "This message cannot fit into one byte.",
        format: "plain",
      },
    });
    expect(oversizedDraft.ok).toBe(true);
    if (!oversizedDraft.ok) return;
    const oversizedSend = await createActorCommand({
      context,
      mailboxId: mailbox.data.id,
      input: {
        kind: "send",
        draftId: oversizedDraft.data.id,
        expectedDraftRevision: oversizedDraft.data.revision,
        senderIdentityId: identity!.id,
        undoSeconds: 0,
        idempotencyKey: `oversized-send-${suffix}`,
      },
    });
    expect(oversizedSend).toEqual(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({
          message: expect.stringContaining("mail provider allows at most 1 B"),
        }),
      }),
    );
    await sql`
      UPDATE mail.provider_connections
      SET limit_snapshot = ${unavailableProviderLimitSnapshot()}::jsonb
      WHERE id = ${connection!.id}::uuid
    `;
    const discardScheduledDraft = await createDraft({
      context,
      mailboxId: mailbox.data.id,
      input: {
        senderIdentityId: identity!.id,
        to: [{ name: "Recipient", address: "recipient@example.com" }],
        cc: [],
        bcc: [],
        subject: "Discard scheduled message",
        body: "This scheduled message will be discarded.",
        format: "plain",
      },
    });
    expect(discardScheduledDraft.ok).toBe(true);
    if (!discardScheduledDraft.ok) return;
    const pastScheduledCommand = await createActorCommand({
      context,
      mailboxId: mailbox.data.id,
      input: {
        kind: "send",
        draftId: discardScheduledDraft.data.id,
        expectedDraftRevision: discardScheduledDraft.data.revision,
        senderIdentityId: identity!.id,
        scheduledAt: new Date(Date.now() - 60_000).toISOString(),
        undoSeconds: 0,
        idempotencyKey: `past-scheduled-${suffix}`,
      },
    });
    expect(pastScheduledCommand.ok).toBe(false);
    const discardScheduledAt = new Date(Date.now() + 60 * 60_000).toISOString();
    const discardScheduledCommand = await createActorCommand({
      context,
      mailboxId: mailbox.data.id,
      input: {
        kind: "send",
        draftId: discardScheduledDraft.data.id,
        expectedDraftRevision: discardScheduledDraft.data.revision,
        senderIdentityId: identity!.id,
        scheduledAt: discardScheduledAt,
        undoSeconds: 30,
        idempotencyKey: `discard-scheduled-${suffix}`,
      },
    });
    expect(discardScheduledCommand.ok).toBe(true);
    if (!discardScheduledCommand.ok) return;
    const [discardScheduledOutbox] = await sql<{ id: string; scheduled_at: Date; undo_until: Date }[]>`
      SELECT id, scheduled_at, undo_until
      FROM mail.outbox_submissions
      WHERE command_id = ${discardScheduledCommand.data.id}::uuid
    `;
    expect(discardScheduledOutbox!.scheduled_at.toISOString()).toBe(discardScheduledAt);
    expect(discardScheduledOutbox!.undo_until.toISOString()).toBe(discardScheduledAt);
    const secondScheduledDraft = await createDraft({
      context,
      mailboxId: mailbox.data.id,
      input: {
        senderIdentityId: identity!.id,
        to: [{ name: "Recipient", address: "recipient@example.com" }],
        cc: [],
        bcc: [],
        subject: "Second scheduled message",
        body: "This message verifies stable scheduled-send pagination.",
        format: "plain",
      },
    });
    expect(secondScheduledDraft.ok).toBe(true);
    if (!secondScheduledDraft.ok) return;
    const secondScheduledCommand = await createActorCommand({
      context,
      mailboxId: mailbox.data.id,
      input: {
        kind: "send",
        draftId: secondScheduledDraft.data.id,
        expectedDraftRevision: secondScheduledDraft.data.revision,
        senderIdentityId: identity!.id,
        scheduledAt: discardScheduledAt,
        undoSeconds: 0,
        idempotencyKey: `second-scheduled-${suffix}`,
      },
    });
    expect(secondScheduledCommand.ok).toBe(true);
    if (!secondScheduledCommand.ok) return;
    const firstScheduledPage = await listScheduledSends({ context, mailboxId: mailbox.data.id, limit: 1 });
    expect(firstScheduledPage.ok).toBe(true);
    if (!firstScheduledPage.ok) return;
    expect(firstScheduledPage.data.items).toHaveLength(1);
    expect(firstScheduledPage.data.total).toBe(2);
    expect(firstScheduledPage.data.nextCursor).not.toBeNull();
    const firstScheduledItem = firstScheduledPage.data.items[0]!;
    const firstScheduledItemDbId = firstScheduledItem.id;
    let requestedAtMutationError: unknown;
    try {
      await sql`
        UPDATE mail.outbox_submissions
        SET requested_at = requested_at + interval '1 second'
        WHERE id = ${firstScheduledItemDbId}::uuid
      `;
    } catch (error) {
      requestedAtMutationError = error;
    }
    expect(requestedAtMutationError).toMatchObject({ errno: "55000" });
    await sql`
      UPDATE mail.outbox_submissions
      SET
        scheduled_at = requested_at + interval '15 minutes',
        last_error_code = 'SMTP_TEMPORARY',
        last_error_message = 'Temporary SMTP failure'
      WHERE id = ${firstScheduledItemDbId}::uuid
    `;
    const secondScheduledPage = await listScheduledSends({
      context,
      mailboxId: mailbox.data.id,
      cursor: firstScheduledPage.data.nextCursor!,
      limit: 1,
    });
    expect(secondScheduledPage.ok).toBe(true);
    if (!secondScheduledPage.ok) return;
    expect(secondScheduledPage.data.items).toHaveLength(1);
    expect(secondScheduledPage.data.items[0]!.id).not.toBe(firstScheduledItem.id);
    expect(secondScheduledPage.data.nextCursor).toBeNull();
    const completeScheduledPage = await listScheduledSends({ context, mailboxId: mailbox.data.id, limit: 10 });
    expect(completeScheduledPage.ok).toBe(true);
    if (!completeScheduledPage.ok) return;
    const retriedScheduledItem = completeScheduledPage.data.items.find((item) => item.id === firstScheduledItem.id);
    expect(retriedScheduledItem?.scheduledAt).toBe(discardScheduledAt);
    expect(retriedScheduledItem?.nextAttemptAt).toBe(new Date(Date.parse(discardScheduledAt) + 15 * 60_000).toISOString());
    expect(retriedScheduledItem?.lastError).toBe("Temporary SMTP failure");
    const discardedSchedule = await cancelScheduledSend({
      context,
      mailboxId: mailbox.data.id,
      scheduledSendId: discardScheduledOutbox!.id,
      input: { disposition: "discard" },
    });
    expect(discardedSchedule.ok && discardedSchedule.data.disposition).toBe("discard");
    const [discardedScheduleState] = await sql<{ draft_state: string; outbox_state: string; command_state: string }[]>`
      SELECT draft.state AS draft_state, outbox.state AS outbox_state, command.state AS command_state
      FROM mail.outbox_submissions outbox
      JOIN mail.commands command ON command.id = outbox.command_id
      JOIN mail.drafts draft ON draft.id = outbox.draft_id
      WHERE outbox.id = ${discardScheduledOutbox!.id}::uuid
    `;
    expect(discardedScheduleState).toEqual({
      draft_state: "discarded",
      outbox_state: "cancelled",
      command_state: "cancelled",
    });
    const repeatedScheduleCancellation = await cancelScheduledSend({
      context,
      mailboxId: mailbox.data.id,
      scheduledSendId: discardScheduledOutbox!.id,
      input: { disposition: "draft" },
    });
    expect(repeatedScheduleCancellation.ok).toBe(false);
    const [secondScheduledOutbox] = await sql<{ id: string }[]>`
      SELECT id FROM mail.outbox_submissions WHERE command_id = ${secondScheduledCommand.data.id}::uuid
    `;
    const restoredSchedule = await cancelScheduledSend({
      context,
      mailboxId: mailbox.data.id,
      scheduledSendId: secondScheduledOutbox!.id,
      input: { disposition: "draft" },
    });
    expect(restoredSchedule.ok && restoredSchedule.data.disposition).toBe("draft");
    expect(
      (
        await createDraftAttachmentUpload({
          context,
          mailboxId: mailbox.data.id,
          draftId: draft.data.id,
          input: { filename: "too-large.bin", contentType: "application/octet-stream", byteLength: 100 * 1024 * 1024 + 1 },
        })
      ).ok,
    ).toBe(false);
    const resumedBytes = Buffer.alloc(1024 * 1024 + 17, 7);
    const upload = await createDraftAttachmentUpload({
      context,
      mailboxId: mailbox.data.id,
      draftId: draft.data.id,
      input: { filename: "resumed.bin", contentType: "application/octet-stream", byteLength: resumedBytes.length },
    });
    if (!upload.ok) throw new Error(`${upload.error.code}: ${upload.error.message}`);
    expect(
      (
        await appendDraftAttachmentUpload({
          context,
          mailboxId: mailbox.data.id,
          draftId: draft.data.id,
          uploadId: upload.data.id,
          offset: 1,
          bytes: resumedBytes.subarray(0, 16),
        })
      ).ok,
    ).toBe(false);
    const partialNonFinalChunk = await appendDraftAttachmentUpload({
      context,
      mailboxId: mailbox.data.id,
      draftId: draft.data.id,
      uploadId: upload.data.id,
      offset: 0,
      bytes: resumedBytes.subarray(0, 16),
    });
    expect(partialNonFinalChunk.ok).toBe(false);
    if (!partialNonFinalChunk.ok) expect(partialNonFinalChunk.error.code).toBe("BAD_INPUT");
    const firstChunk = await appendDraftAttachmentUpload({
      context,
      mailboxId: mailbox.data.id,
      draftId: draft.data.id,
      uploadId: upload.data.id,
      offset: 0,
      bytes: resumedBytes.subarray(0, 1024 * 1024),
    });
    expect(firstChunk.ok && firstChunk.data.receivedBytes).toBe(1024 * 1024);
    const resumed = await getDraftAttachmentUpload({
      context,
      mailboxId: mailbox.data.id,
      draftId: draft.data.id,
      uploadId: upload.data.id,
    });
    expect(resumed.ok && resumed.data.receivedBytes).toBe(1024 * 1024);
    const completedUpload = await appendDraftAttachmentUpload({
      context,
      mailboxId: mailbox.data.id,
      draftId: draft.data.id,
      uploadId: upload.data.id,
      offset: 1024 * 1024,
      bytes: resumedBytes.subarray(1024 * 1024),
    });
    expect(completedUpload.ok && completedUpload.data.state).toBe("uploaded");
    const draftWithResumedAttachment = await finalizeDraftAttachmentUpload({
      context,
      mailboxId: mailbox.data.id,
      draftId: draft.data.id,
      uploadId: upload.data.id,
      expectedRevision: draftWithAttachment.data.revision + 1,
    });
    expect(draftWithResumedAttachment.ok && draftWithResumedAttachment.data.attachments).toHaveLength(2);
    if (!draftWithResumedAttachment.ok) return;
    const resumedAttachment = draftWithResumedAttachment.data.attachments.find((attachment) => attachment.filename === "resumed.bin");
    expect(resumedAttachment).toBeDefined();
    if (!resumedAttachment) return;
    const [resumedBlob] = await sql<{ blob_id: string }[]>`
      SELECT blob_id FROM mail.draft_attachments WHERE id = ${resumedAttachment.id}::uuid
    `;
    ids.blobIds.push(resumedBlob!.blob_id);

    const streamedBytes = Buffer.alloc(2 * 1024 * 1024 + 123);
    for (let index = 0; index < streamedBytes.byteLength; index += 1) streamedBytes[index] = index % 251;
    const streamFragments = Array.from({ length: Math.ceil(streamedBytes.byteLength / (64 * 1024)) }, (_, index) =>
      streamedBytes.subarray(index * 64 * 1024, Math.min((index + 1) * 64 * 1024, streamedBytes.byteLength)),
    );
    const draftWithStreamedAttachment = await uploadDraftAttachmentStream({
      context,
      mailboxId: mailbox.data.id,
      draftId: draft.data.id,
      expectedRevision: draftWithResumedAttachment.data.revision,
      filename: "fragmented-stream.bin",
      contentType: "application/octet-stream",
      byteLength: streamedBytes.byteLength,
      stream: Readable.from(streamFragments),
    });
    expect(draftWithStreamedAttachment.ok && draftWithStreamedAttachment.data.attachments).toHaveLength(3);
    if (!draftWithStreamedAttachment.ok) return;
    const streamedAttachment = draftWithStreamedAttachment.data.attachments.find(
      (attachment) => attachment.filename === "fragmented-stream.bin",
    );
    if (!streamedAttachment) throw new Error("Streamed attachment fixture was not attached");
    const [streamedBlob] = await sql<{ blob_id: string; chunk_size: number; chunk_count: number }[]>`
      SELECT blob.id AS blob_id, blob.chunk_size, blob.chunk_count
      FROM mail.draft_attachments attachment
      JOIN mail.message_part_blobs blob ON blob.id = attachment.blob_id
      WHERE attachment.id = ${streamedAttachment.id}::uuid
    `;
    if (!streamedBlob) throw new Error("Streamed attachment blob fixture is unavailable");
    ids.blobIds.push(streamedBlob.blob_id);
    const streamedChunkLengths = await sql<{ byte_length: number }[]>`
      SELECT octet_length(bytes)::int AS byte_length
      FROM mail.message_part_chunks
      WHERE blob_id = ${streamedBlob.blob_id}::uuid
      ORDER BY position
    `;
    expect(streamedChunkLengths.map((chunk) => chunk.byte_length)).toEqual([1024 * 1024, 1024 * 1024, 123]);
    const fullStreamedDownload = Buffer.from(
      await new Response(
        createAttachmentStream({
          blobId: streamedBlob.blob_id,
          chunkSize: streamedBlob.chunk_size,
          chunkCount: streamedBlob.chunk_count,
          start: 0,
          endExclusive: streamedBytes.byteLength,
        }),
      ).arrayBuffer(),
    );
    expect(fullStreamedDownload.equals(streamedBytes)).toBe(true);
    const streamedRangeStart = 1024 * 1024 - 37;
    const streamedRangeEnd = 2 * 1024 * 1024 + 59;
    const rangedStreamedDownload = Buffer.from(
      await new Response(
        createAttachmentStream({
          blobId: streamedBlob.blob_id,
          chunkSize: streamedBlob.chunk_size,
          chunkCount: streamedBlob.chunk_count,
          start: streamedRangeStart,
          endExclusive: streamedRangeEnd,
        }),
      ).arrayBuffer(),
    );
    expect(rangedStreamedDownload.equals(streamedBytes.subarray(streamedRangeStart, streamedRangeEnd))).toBe(true);
    const withoutFirstAttachment = await removeDraftAttachment({
      context,
      mailboxId: mailbox.data.id,
      draftId: draft.data.id,
      attachmentId: draftWithAttachment.data.attachments[0]!.id,
      expectedRevision: draftWithStreamedAttachment.data.revision,
    });
    expect(withoutFirstAttachment.ok).toBe(true);
    if (!withoutFirstAttachment.ok) return;
    const withoutAttachment = await removeDraftAttachment({
      context,
      mailboxId: mailbox.data.id,
      draftId: draft.data.id,
      attachmentId: resumedAttachment.id,
      expectedRevision: withoutFirstAttachment.data.revision,
    });
    expect(withoutAttachment.ok && withoutAttachment.data.attachments.map((attachment) => attachment.id)).toEqual([streamedAttachment.id]);
    if (!withoutAttachment.ok) return;
    const withoutStreamedAttachment = await removeDraftAttachment({
      context,
      mailboxId: mailbox.data.id,
      draftId: draft.data.id,
      attachmentId: streamedAttachment.id,
      expectedRevision: withoutAttachment.data.revision,
    });
    expect(withoutStreamedAttachment.ok && withoutStreamedAttachment.data.attachments).toEqual([]);
    if (!withoutStreamedAttachment.ok) return;
    const discarded = await discardDraft({
      context,
      mailboxId: mailbox.data.id,
      draftId: draft.data.id,
      expectedRevision: withoutStreamedAttachment.data.revision,
    });
    expect(discarded.ok && discarded.data.state).toBe("discarded");
    const attachmentActivity = await sql<{ action: string; target_type: string }[]>`
      SELECT action, target_type
      FROM mail.activity_events
      WHERE mailbox_id = ${mailbox.data.id}::uuid
        AND (
          (action IN ('draft.attachment_added', 'draft.attachment_removed') AND metadata->>'draftId' = ${draft.data.id})
          OR (target_type = 'draft' AND target_id = ${draft.data.id}::uuid AND action = 'draft.discarded')
        )
      ORDER BY id
    `;
    expect(attachmentActivity).toEqual([
      { action: "draft.attachment_added", target_type: "draft_attachment" },
      { action: "draft.attachment_added", target_type: "draft_attachment" },
      { action: "draft.attachment_added", target_type: "draft_attachment" },
      { action: "draft.attachment_removed", target_type: "draft_attachment" },
      { action: "draft.attachment_removed", target_type: "draft_attachment" },
      { action: "draft.attachment_removed", target_type: "draft_attachment" },
      { action: "draft.discarded", target_type: "draft" },
    ]);

    const [message] = await sql<{ id: string; short_id: string }[]>`
      INSERT INTO mail.message_contents (
        short_id, mailbox_id, message_id, subject, internal_date, size_bytes, content_hash,
        hydration_status, plain_text, normalized_subject
      ) VALUES (
        ${newShortId()}, ${mailbox.data.id}::uuid, '<integration@example.com>', 'Searchable subject', now(), 42,
        ${"b".repeat(64)}, 'complete', 'A unique integration body phrase', 'searchable subject'
      ) RETURNING id, short_id
    `;
    await sql`
      INSERT INTO mail.message_search_chunks (message_id, mailbox_id, position, search_document)
      VALUES
        (${message!.id}::uuid, ${mailbox.data.id}::uuid, 0, to_tsvector('simple'::regconfig, 'A unique integration body phrase')),
        (${message!.id}::uuid, ${mailbox.data.id}::uuid, 1, to_tsvector('simple'::regconfig, 'cobalt'))
    `;
    await sql`
      INSERT INTO mail.message_addresses (message_id, role, position, display_name, email, normalized_email)
      VALUES (${message!.id}::uuid, 'from', 0, 'Alice Fixture', 'alice@example.com', 'alice@example.com')
    `;
    const [remoteRef] = await sql<{ id: string }[]>`
      INSERT INTO mail.remote_message_refs (folder_id, message_id, uid_validity, uid)
      VALUES (${folder!.id}::uuid, ${message!.id}::uuid, 1, 1)
      RETURNING id
    `;
    await sql`
      INSERT INTO mail.message_placements (remote_message_ref_id, folder_id, message_id, flags, keywords)
      VALUES (${remoteRef!.id}::uuid, ${folder!.id}::uuid, ${message!.id}::uuid, ARRAY[]::text[], ARRAY[]::text[])
    `;
    const [attachmentConversation] = await sql<{ id: string; short_id: string }[]>`
      INSERT INTO mail.conversations (
        short_id, mailbox_id, subject, participant_summary, latest_inbound_at, latest_message_at
      ) VALUES (
        ${newShortId()}, ${mailbox.data.id}::uuid, 'Searchable subject', 'Alice Fixture', now(), now()
      )
      RETURNING id, short_id
    `;
    await sql`
      INSERT INTO mail.conversation_messages (conversation_id, message_id, position, added_by)
      VALUES (${attachmentConversation!.id}::uuid, ${message!.id}::uuid, 0, 'headers')
    `;
    await sql`
      UPDATE mail.conversations
      SET
        work_status = 'waiting',
        assignee_user_id = ${context.actor.kind === "user" ? context.actor.user.id : null}::uuid
      WHERE id = ${attachmentConversation!.id}::uuid
    `;
    const [secondMatchingMessage] = await sql<{ id: string; short_id: string }[]>`
      INSERT INTO mail.message_contents (
        short_id, mailbox_id, message_id, subject, internal_date, size_bytes, content_hash,
        hydration_status, plain_text, normalized_subject
      ) VALUES (
        ${newShortId()}, ${mailbox.data.id}::uuid, '<integration-2@example.com>', 'Searchable follow-up', now() + interval '1 second', 43,
        ${"c".repeat(64)}, 'complete', 'A second unique integration body phrase', 'searchable follow-up'
      ) RETURNING id, short_id
    `;
    await sql`
      INSERT INTO mail.message_search_chunks (message_id, mailbox_id, position, search_document)
      VALUES (
        ${secondMatchingMessage!.id}::uuid,
        ${mailbox.data.id}::uuid,
        0,
        to_tsvector('simple'::regconfig, 'A second unique integration body phrase')
      )
    `;
    await sql`
      INSERT INTO mail.message_addresses (message_id, role, position, display_name, email, normalized_email)
      VALUES
        (${secondMatchingMessage!.id}::uuid, 'from', 0, 'Fixture Sender', 'sender@example.com', 'sender@example.com'),
        (${secondMatchingMessage!.id}::uuid, 'to', 0, 'Alice Fixture', 'alice@example.com', 'alice@example.com'),
        (${secondMatchingMessage!.id}::uuid, 'cc', 0, 'Bob Fixture', 'bob@example.com', 'bob@example.com')
    `;
    const [secondRemoteRef] = await sql<{ id: string }[]>`
      INSERT INTO mail.remote_message_refs (folder_id, message_id, uid_validity, uid)
      VALUES (${folder!.id}::uuid, ${secondMatchingMessage!.id}::uuid, 1, 99)
      RETURNING id
    `;
    await sql`
      INSERT INTO mail.message_placements (remote_message_ref_id, folder_id, message_id, flags, keywords)
      VALUES (
        ${secondRemoteRef!.id}::uuid,
        ${folder!.id}::uuid,
        ${secondMatchingMessage!.id}::uuid,
        ARRAY[]::text[],
        ARRAY[]::text[]
      )
    `;
    await sql`
      INSERT INTO mail.conversation_messages (conversation_id, message_id, position, added_by)
      VALUES (${attachmentConversation!.id}::uuid, ${secondMatchingMessage!.id}::uuid, 1, 'headers')
    `;
    const result = await searchMessages({
      context,
      mailboxId: mailbox.data.id,
      request: {
        expression: {
          type: "and",
          expressions: [
            { type: "text", field: "from", query: "alice@example.com", match: "exact" },
            { type: "text", field: "body", query: "unique integration", match: "phrase" },
          ],
        },
        sort: "relevance",
        limit: 10,
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const conversationHits = result.data.items.filter((item) => item.conversationId === attachmentConversation!.id);
      expect(conversationHits).toHaveLength(1);
      expect(conversationHits[0]).toMatchObject({
        participantSummary: "Alice Fixture",
        participantLabels: ["Alice Fixture", "Bob Fixture"],
        workStatus: "waiting",
        assigneeUserId: context.actor.kind === "user" ? context.actor.user.id : null,
        unread: true,
        messageCount: 2,
        sourceFolderId: folder!.id,
        unreadFolderIds: [folder!.id],
      });
    }
    const individualMessages = await searchMessages({
      context,
      mailboxId: mailbox.data.id,
      groupByConversation: false,
      request: {
        expression: { type: "all" },
        sort: "newest",
        limit: 100,
      },
    });
    expect(individualMessages.ok).toBe(true);
    if (individualMessages.ok) {
      const messageHits = individualMessages.data.items.filter((item) => item.conversationId === attachmentConversation!.id);
      expect(messageHits).toHaveLength(2);
      expect(messageHits.every((item) => item.messageCount === 2)).toBe(true);
      expect(new Set(messageHits.map((item) => item.id)).size).toBe(2);
    }
    const listResult = await listConversations({ context, mailboxId: mailbox.data.id, limit: 100 });
    expect(listResult.ok).toBe(true);
    if (listResult.ok) {
      expect(listResult.data.items.find((item) => item.id === attachmentConversation!.id)?.participantLabels).toEqual([
        "Alice Fixture",
        "Bob Fixture",
      ]);
    }
    const crossChunkWords = await searchMessages({
      context,
      mailboxId: mailbox.data.id,
      request: {
        expression: { type: "text", field: "body", query: "unique cobalt", match: "words" },
        sort: "relevance",
        limit: 10,
      },
    });
    expect(crossChunkWords.ok && crossChunkWords.data.items.map((item) => item.conversationId)).toContain(attachmentConversation!.id);

    const searchableAttachmentBytes = Buffer.from("nebula zircon attachment fixture");
    const searchableAttachmentBlob = await storeReadableBlob(Readable.from([searchableAttachmentBytes]), searchableAttachmentBytes.length);
    ids.blobIds.push(searchableAttachmentBlob.id);
    const [searchableAttachmentPart] = await sql<{ id: string }[]>`
      INSERT INTO mail.message_parts (
        message_id, part_path, content_type, disposition, filename, size_bytes, blob_id, hydration_status
      ) VALUES (
        ${secondMatchingMessage!.id}::uuid, 'searchable-attachment', 'text/plain', 'attachment',
        'searchable-notes.txt', ${searchableAttachmentBytes.length}, ${searchableAttachmentBlob.id}::uuid, 'complete'
      )
      RETURNING id
    `;
    const [searchableAttachment] = await sql<{ id: string }[]>`
      INSERT INTO mail.attachments (
        short_id, message_id, part_id, filename, content_type, disposition, checksum, size_bytes, blob_id
      ) VALUES (
        ${newShortId()}, ${secondMatchingMessage!.id}::uuid, ${searchableAttachmentPart!.id}::uuid, 'searchable-notes.txt', 'text/plain',
        'attachment', ${searchableAttachmentBlob.contentHash}, ${searchableAttachmentBytes.length}, ${searchableAttachmentBlob.id}::uuid
      )
      RETURNING id
    `;
    await sql`
      INSERT INTO mail.attachment_extractions (
        blob_id, extractor_version, status, format, markdown, input_bytes, output_bytes, completed_at
      ) VALUES (
        ${searchableAttachmentBlob.id}::uuid, ${MAIL_ATTACHMENT_EXTRACTOR_VERSION}, 'complete', 'text',
        'nebula zircon attachment fixture', ${searchableAttachmentBytes.length}, ${searchableAttachmentBytes.length}, now()
      )
    `;
    await sql`
      INSERT INTO mail.message_search_chunks (
        message_id, mailbox_id, position, search_document, source_kind, attachment_id, blob_id, extractor_version
      ) VALUES
        (
          ${secondMatchingMessage!.id}::uuid, ${mailbox.data.id}::uuid, 0, to_tsvector('simple'::regconfig, 'nebula'),
          'attachment', ${searchableAttachment!.id}::uuid, ${searchableAttachmentBlob.id}::uuid, ${MAIL_ATTACHMENT_EXTRACTOR_VERSION}
        ),
        (
          ${secondMatchingMessage!.id}::uuid, ${mailbox.data.id}::uuid, 1, to_tsvector('simple'::regconfig, 'zircon'),
          'attachment', ${searchableAttachment!.id}::uuid, ${searchableAttachmentBlob.id}::uuid, ${MAIL_ATTACHMENT_EXTRACTOR_VERSION}
        )
    `;
    const crossChunkAttachmentWords = await searchMessages({
      context,
      mailboxId: mailbox.data.id,
      request: {
        expression: { type: "text", field: "any", query: "nebula zircon", match: "words" },
        sort: "relevance",
        limit: 10,
      },
    });
    expect(crossChunkAttachmentWords.ok).toBe(true);
    if (crossChunkAttachmentWords.ok) {
      expect(
        crossChunkAttachmentWords.data.items.find((item) => item.conversationId === attachmentConversation!.id)?.attachmentMatch,
      ).toMatchObject({
        attachmentId: searchableAttachment!.id,
        messageId: secondMatchingMessage!.id,
        filename: "searchable-notes.txt",
        reason: "attachment_content",
      });
    }
    await sql`
      INSERT INTO mail.message_search_chunks (
        message_id, mailbox_id, position, search_document, source_kind, attachment_id, blob_id, extractor_version
      ) VALUES (
        ${secondMatchingMessage!.id}::uuid, ${mailbox.data.id}::uuid, 0, to_tsvector('simple'::regconfig, 'staleonly'),
        'attachment', ${searchableAttachment!.id}::uuid, ${searchableAttachmentBlob.id}::uuid, 'previous-extractor-version'
      )
    `;
    const staleAttachmentVersion = await searchMessages({
      context,
      mailboxId: mailbox.data.id,
      request: {
        expression: { type: "text", field: "any", query: "staleonly", match: "words" },
        sort: "relevance",
        limit: 10,
      },
    });
    expect(staleAttachmentVersion.ok).toBe(true);
    if (staleAttachmentVersion.ok) {
      expect(staleAttachmentVersion.data.items.map((item) => item.conversationId)).not.toContain(attachmentConversation!.id);
    }
    const crossBodyAttachmentWords = await searchMessages({
      context,
      mailboxId: mailbox.data.id,
      request: {
        expression: { type: "text", field: "any", query: "second nebula", match: "words" },
        sort: "relevance",
        limit: 10,
      },
    });
    expect(crossBodyAttachmentWords.ok).toBe(true);
    if (crossBodyAttachmentWords.ok) {
      expect(crossBodyAttachmentWords.data.items.map((item) => item.conversationId)).not.toContain(attachmentConversation!.id);
    }

    const secondAttachmentBytes = Buffer.from("quasar attachment fixture");
    const secondAttachmentBlob = await storeReadableBlob(Readable.from([secondAttachmentBytes]), secondAttachmentBytes.length);
    ids.blobIds.push(secondAttachmentBlob.id);
    const [secondAttachmentPart] = await sql<{ id: string }[]>`
      INSERT INTO mail.message_parts (
        message_id, part_path, content_type, disposition, filename, size_bytes, blob_id, hydration_status
      ) VALUES (
        ${secondMatchingMessage!.id}::uuid, 'second-searchable-attachment', 'text/plain', 'attachment',
        'quasar-notes.txt', ${secondAttachmentBytes.length}, ${secondAttachmentBlob.id}::uuid, 'complete'
      )
      RETURNING id
    `;
    const [secondAttachment] = await sql<{ id: string }[]>`
      INSERT INTO mail.attachments (
        short_id, message_id, part_id, filename, content_type, disposition, checksum, size_bytes, blob_id
      ) VALUES (
        ${newShortId()}, ${secondMatchingMessage!.id}::uuid, ${secondAttachmentPart!.id}::uuid, 'quasar-notes.txt', 'text/plain',
        'attachment', ${secondAttachmentBlob.contentHash}, ${secondAttachmentBytes.length}, ${secondAttachmentBlob.id}::uuid
      )
      RETURNING id
    `;
    await sql`
      INSERT INTO mail.attachment_extractions (
        blob_id, extractor_version, status, format, markdown, input_bytes, output_bytes, completed_at
      ) VALUES (
        ${secondAttachmentBlob.id}::uuid, ${MAIL_ATTACHMENT_EXTRACTOR_VERSION}, 'complete', 'text',
        'quasar attachment fixture', ${secondAttachmentBytes.length}, ${secondAttachmentBytes.length}, now()
      )
    `;
    await sql`
      INSERT INTO mail.message_search_chunks (
        message_id, mailbox_id, position, search_document, source_kind, attachment_id, blob_id, extractor_version
      ) VALUES (
        ${secondMatchingMessage!.id}::uuid, ${mailbox.data.id}::uuid, 0, to_tsvector('simple'::regconfig, 'quasar'),
        'attachment', ${secondAttachment!.id}::uuid, ${secondAttachmentBlob.id}::uuid, ${MAIL_ATTACHMENT_EXTRACTOR_VERSION}
      )
    `;
    const crossAttachmentWords = await searchMessages({
      context,
      mailboxId: mailbox.data.id,
      request: {
        expression: { type: "text", field: "any", query: "nebula quasar", match: "words" },
        sort: "relevance",
        limit: 10,
      },
    });
    expect(crossAttachmentWords.ok).toBe(true);
    if (crossAttachmentWords.ok) {
      expect(crossAttachmentWords.data.items.map((item) => item.conversationId)).not.toContain(attachmentConversation!.id);
    }
    const [secondaryFolder] = await sql<{ id: string; short_id: string }[]>`
      INSERT INTO mail.folders (short_id, remote_resource_id, stable_key, name, role, sync_status)
      VALUES (${newShortId()}, ${resource!.id}::uuid, ${`secondary-${suffix}`}, 'Secondary', 'other', 'current')
      RETURNING id, short_id
    `;
    const [secondaryRef] = await sql<{ id: string }[]>`
      INSERT INTO mail.remote_message_refs (folder_id, message_id, uid_validity, uid)
      VALUES (${secondaryFolder!.id}::uuid, ${secondMatchingMessage!.id}::uuid, 1, 1)
      RETURNING id
    `;
    await sql`
      INSERT INTO mail.message_placements (
        remote_message_ref_id, folder_id, message_id, flags, keywords, updated_at
      ) VALUES (
        ${secondaryRef!.id}::uuid,
        ${secondaryFolder!.id}::uuid,
        ${secondMatchingMessage!.id}::uuid,
        ARRAY[]::text[],
        ARRAY[]::text[],
        now() - interval '1 day'
      )
    `;
    const excludedConversationList = await listConversations({
      context,
      mailboxId: mailbox.data.id,
      excludedFolderIds: [folder!.id, secondaryFolder!.id],
      limit: 100,
    });
    expect(excludedConversationList.ok).toBe(true);
    if (excludedConversationList.ok) {
      expect(excludedConversationList.data.items.map((item) => item.id)).not.toContain(attachmentConversation!.id);
    }
    const excludedMessageList = await searchMessages({
      context,
      mailboxId: mailbox.data.id,
      excludedFolderIds: [folder!.id, secondaryFolder!.id],
      groupByConversation: false,
      request: { expression: { type: "all" }, sort: "newest", limit: 100 },
    });
    expect(excludedMessageList.ok).toBe(true);
    if (excludedMessageList.ok) {
      expect(excludedMessageList.data.items.map((item) => item.conversationId)).not.toContain(attachmentConversation!.id);
    }
    const folderScoped = await searchMessages({
      context,
      mailboxId: mailbox.data.id,
      request: {
        expression: { type: "folder_id", folderId: folder!.id },
        sort: "newest",
        limit: 10,
      },
    });
    expect(folderScoped.ok).toBe(true);
    if (folderScoped.ok) {
      const hit = folderScoped.data.items.find((item) => item.conversationId === attachmentConversation!.id);
      expect(hit?.unreadFolderIds).toEqual([folder!.id]);
      expect(hit?.snippet).toBe("A second unique integration body phrase");
      expect(hit?.sourceFolderId).toBe(folder!.id);
    }
    const ambiguousSource = await searchMessages({
      context,
      mailboxId: mailbox.data.id,
      request: {
        expression: { type: "text", field: "body", query: "second unique integration", match: "phrase" },
        sort: "relevance",
        limit: 10,
      },
    });
    expect(ambiguousSource.ok).toBe(true);
    if (ambiguousSource.ok) {
      const hit = ambiguousSource.data.items.find((item) => item.conversationId === attachmentConversation!.id);
      expect(hit?.sourceFolderId).toBeNull();
      expect(hit?.snippet).toContain("second unique integration body phrase");
      expect(hit?.snippet).not.toContain(",");
    }
    const assignedRelevancePage = await searchMessages({
      context,
      mailboxId: mailbox.data.id,
      request: {
        expression: { type: "assigned_to_me" },
        sort: "relevance",
        limit: 1,
      },
    });
    expect(assignedRelevancePage.ok).toBe(true);
    if (assignedRelevancePage.ok) {
      expect(assignedRelevancePage.data.items).toHaveLength(1);
      expect(assignedRelevancePage.data.items[0]?.conversationId).toBe(attachmentConversation!.id);
      expect(assignedRelevancePage.data.nextCursor).toBeNull();
    }
    const oneConversationPage = await searchMessages({
      context,
      mailboxId: mailbox.data.id,
      request: {
        expression: { type: "text", field: "from", query: "alice@example.com", match: "exact" },
        sort: "newest",
        limit: 1,
      },
    });
    expect(oneConversationPage.ok).toBe(true);
    if (oneConversationPage.ok) {
      expect(oneConversationPage.data.items).toHaveLength(1);
      expect(oneConversationPage.data.nextCursor).toBeNull();
    }

    const [uidValidityDraft] = await sql<{ id: string; revision: number }[]>`
      INSERT INTO mail.drafts (
        short_id, mailbox_id, intent, sender_identity_id,
        author_kind, author_id, last_editor_kind, last_editor_id,
        to_addresses, cc_addresses, bcc_addresses, subject, body_markdown, body_format
      ) VALUES (
        ${newShortId()},
        ${mailbox.data.id}::uuid,
        'new',
        ${identity!.id}::uuid,
        'user',
        ${ids.userIds[0]}::uuid,
        'user',
        ${ids.userIds[0]}::uuid,
        ${[{ name: "Recipient", address: "recipient@example.com" }]}::jsonb,
        '[]'::jsonb,
        '[]'::jsonb,
        'UIDVALIDITY projection',
        'Provider namespace reset fixture',
        'plain'
      )
      RETURNING id, revision
    `;
    const projectedMessageId = `<uidvalidity-${suffix}@example.com>`;
    const [projection] = await sql<{ id: string }[]>`
      INSERT INTO mail.draft_provider_snapshots (
        mailbox_id, draft_id, cloud_revision, direction, state,
        stable_message_id, content_fingerprint, remote_resource_id, binding_id,
        folder_id, uid_validity, uid, modseq, completed_at
      ) VALUES (
        ${mailbox.data.id}::uuid,
        ${uidValidityDraft!.id}::uuid,
        ${uidValidityDraft!.revision},
        'export',
        'active',
        ${projectedMessageId},
        ${"e".repeat(64)},
        ${resource!.id}::uuid,
        ${binding!.id}::uuid,
        ${folder!.id}::uuid,
        10,
        41,
        1,
        now()
      )
      RETURNING id
    `;
    const projectedEnvelope: ConnectorEnvelope = {
      remoteRef: { folderStableKey: folder!.id, uidValidity: "11", uid: "7", modseq: "2" },
      providerMessageId: null,
      providerThreadId: null,
      messageId: projectedMessageId,
      inReplyTo: null,
      references: [],
      subject: "UIDVALIDITY projection",
      sentAt: null,
      internalDate: new Date(),
      sizeBytes: 512,
      flags: ["\\Draft"],
      labels: [],
      addresses: { from: [], replyTo: [], to: [], cc: [], bcc: [] },
      mimeStructure: {},
    };
    const remappedProjection = await sql.begin((tx) =>
      recordDraftFolderSyncInTransaction({
        db: tx,
        mailboxId: mailbox.data.id,
        remoteResourceId: resource!.id,
        bindingId: binding!.id,
        folderId: folder!.id,
        uidValidity: "11",
        uidValidityChanged: true,
        envelopes: [projectedEnvelope],
        reconcileWindow: null,
      }),
    );
    expect(remappedProjection.exportSnapshotIds).toEqual([]);
    const [activeRemap] = await sql<{ state: string; uid_validity: string; uid: string; last_error_code: string | null }[]>`
      SELECT state, uid_validity::text, uid::text, last_error_code
      FROM mail.draft_provider_snapshots
      WHERE id = ${projection!.id}::uuid
    `;
    expect(activeRemap).toEqual({ state: "active", uid_validity: "11", uid: "7", last_error_code: null });
    await sql`
      UPDATE mail.drafts
      SET revision = revision + 1, updated_at = now()
      WHERE id = ${uidValidityDraft!.id}::uuid
    `;
    const retiringProjection = await sql.begin((tx) =>
      recordDraftFolderSyncInTransaction({
        db: tx,
        mailboxId: mailbox.data.id,
        remoteResourceId: resource!.id,
        bindingId: binding!.id,
        folderId: folder!.id,
        uidValidity: "12",
        uidValidityChanged: true,
        envelopes: [{ ...projectedEnvelope, remoteRef: { ...projectedEnvelope.remoteRef, uidValidity: "12", uid: "9", modseq: "3" } }],
        reconcileWindow: null,
      }),
    );
    expect(retiringProjection.exportSnapshotIds).toEqual([projection!.id]);
    const [retiringRemap] = await sql<{ state: string; uid_validity: string; uid: string; last_error_code: string | null }[]>`
      SELECT state, uid_validity::text, uid::text, last_error_code
      FROM mail.draft_provider_snapshots
      WHERE id = ${projection!.id}::uuid
    `;
    expect(retiringRemap).toEqual({ state: "retiring", uid_validity: "12", uid: "9", last_error_code: null });

    const attachmentBytes = Buffer.alloc(2 * 1024 * 1024 + 513_123);
    for (let index = 0; index < attachmentBytes.length; index += 1) {
      attachmentBytes[index] = (index * 31 + suffix.charCodeAt(index % suffix.length)) % 256;
    }
    const attachmentBlob = await storeReadableBlob(Readable.from([attachmentBytes]), attachmentBytes.length);
    ids.blobIds.push(attachmentBlob.id);
    const [attachmentPart] = await sql<{ id: string }[]>`
      INSERT INTO mail.message_parts (
        message_id, part_path, content_type, disposition, filename, size_bytes, blob_id, hydration_status
      ) VALUES (
        ${message!.id}::uuid, 'attachment-stream-test', 'application/octet-stream', 'attachment',
        'stream-test.bin', ${attachmentBytes.length}, ${attachmentBlob.id}::uuid, 'complete'
      )
      RETURNING id
    `;
    const [attachment] = await sql<{ id: string; short_id: string }[]>`
      INSERT INTO mail.attachments (
        short_id, message_id, part_id, filename, content_type, disposition, checksum, size_bytes, blob_id
      ) VALUES (
        ${newShortId()}, ${message!.id}::uuid, ${attachmentPart!.id}::uuid, 'stream-test.bin', 'application/octet-stream',
        'attachment', ${attachmentBlob.contentHash}, ${attachmentBytes.length}, ${attachmentBlob.id}::uuid
      )
      RETURNING id, short_id
    `;
    const forwardedDraft = await createDraft({
      context,
      mailboxId: mailbox.data.id,
      input: {
        conversationId: attachmentConversation!.id,
        intent: "forward",
        sourceMessageId: message!.id,
        includeSourceAttachments: true,
        senderIdentityId: identity!.id,
        to: [],
        cc: [],
        bcc: [],
        subject: "Fwd: Searchable subject",
        body: "Forwarded message",
        format: "plain",
      },
    });
    expect(forwardedDraft.ok).toBe(true);
    if (!forwardedDraft.ok) return;
    expect(forwardedDraft.data.attachments).toEqual([
      expect.objectContaining({
        filename: "stream-test.bin",
        byteLength: attachmentBytes.length,
        contentHash: attachmentBlob.contentHash,
        position: 0,
      }),
    ]);
    const [forwardedBlob] = await sql<{ blob_id: string }[]>`
      SELECT blob_id
      FROM mail.draft_attachments
      WHERE draft_id = ${forwardedDraft.data.id}::uuid
    `;
    expect(forwardedBlob?.blob_id).toBe(attachmentBlob.id);
    const forwardWithoutAttachments = await createDraft({
      context,
      mailboxId: mailbox.data.id,
      input: {
        conversationId: attachmentConversation!.id,
        intent: "forward",
        sourceMessageId: message!.id,
        includeSourceAttachments: false,
        senderIdentityId: identity!.id,
        to: [],
        cc: [],
        bcc: [],
        subject: "Fwd: Searchable subject",
        body: "Forwarded without attachments",
        format: "plain",
      },
    });
    expect(forwardWithoutAttachments.ok && forwardWithoutAttachments.data.attachments).toEqual([]);
    const invalidAttachmentCopy = await createDraft({
      context,
      mailboxId: mailbox.data.id,
      input: {
        conversationId: attachmentConversation!.id,
        intent: "reply",
        sourceMessageId: message!.id,
        includeSourceAttachments: true,
        senderIdentityId: identity!.id,
        to: [{ name: "Alice Fixture", address: "alice@example.com" }],
        cc: [],
        bcc: [],
        subject: "Re: Searchable subject",
        body: "Reply",
        format: "plain",
      },
    });
    expect(invalidAttachmentCopy.ok).toBe(false);
    const openedAttachment = await openAttachment({
      context,
      mailboxId: mailbox.data.id,
      messageId: message!.id,
      attachmentId: attachment!.id,
    });
    expect(openedAttachment.ok).toBe(true);
    if (!openedAttachment.ok) return;
    const fullDownload = Buffer.from(
      await new Response(
        createAttachmentStream({
          blobId: openedAttachment.data.blobId,
          chunkSize: openedAttachment.data.chunkSize,
          chunkCount: openedAttachment.data.chunkCount,
          start: 0,
          endExclusive: openedAttachment.data.total,
        }),
      ).arrayBuffer(),
    );
    expect(fullDownload.equals(attachmentBytes)).toBe(true);
    const rangeStart = 1024 * 1024 - 31;
    const rangeEnd = 2 * 1024 * 1024 + 47;
    const rangedDownload = Buffer.from(
      await new Response(
        createAttachmentStream({
          blobId: openedAttachment.data.blobId,
          chunkSize: openedAttachment.data.chunkSize,
          chunkCount: openedAttachment.data.chunkCount,
          start: rangeStart,
          endExclusive: rangeEnd,
        }),
      ).arrayBuffer(),
    );
    expect(rangedDownload.equals(attachmentBytes.subarray(rangeStart, rangeEnd))).toBe(true);
    const sameChunkStart = 11;
    const sameChunkEnd = 21;
    const sameChunkDownload = Buffer.from(
      await new Response(
        createAttachmentStream({
          blobId: openedAttachment.data.blobId,
          chunkSize: openedAttachment.data.chunkSize,
          chunkCount: openedAttachment.data.chunkCount,
          start: sameChunkStart,
          endExclusive: sameChunkEnd,
        }),
      ).arrayBuffer(),
    );
    expect(sameChunkDownload.equals(attachmentBytes.subarray(sameChunkStart, sameChunkEnd))).toBe(true);

    const longBody = Array.from({ length: 110_000 }, (_, index) => `longtoken${index}`)
      .reduce<string[]>((lines, token, index) => {
        const line = Math.floor(index / 100);
        lines[line] = lines[line] ? `${lines[line]} ${token}` : token;
        return lines;
      }, [])
      .join("\r\n");
    const longSource = Buffer.from(
      `From: Large Body <large@example.com>\r\nTo: Recipient <recipient@example.com>\r\nSubject: Large body search\r\nMessage-ID: <large-body@example.com>\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${longBody}`,
      "utf8",
    );
    const [largeMessage] = await sql<{ id: string; short_id: string }[]>`
      INSERT INTO mail.message_contents (
        short_id,
        mailbox_id,
        message_id,
        subject,
        internal_date,
        size_bytes,
        content_hash,
        hydration_status,
        mime_structure
      ) VALUES (
        ${newShortId()},
        ${mailbox.data.id}::uuid,
        '<large-body@example.com>',
        'Large body search',
        now(),
        ${longSource.length},
        ${"e".repeat(64)},
        'envelope',
        ${{ part: "1", type: "text/plain", childNodes: [] }}::jsonb
      ) RETURNING id, short_id
    `;
    const [largeRemoteRef] = await sql<{ id: string }[]>`
      INSERT INTO mail.remote_message_refs (folder_id, message_id, uid_validity, uid)
      VALUES (${folder!.id}::uuid, ${largeMessage!.id}::uuid, 1, 3)
      RETURNING id
    `;
    await sql`
      INSERT INTO mail.message_placements (remote_message_ref_id, folder_id, message_id, flags, keywords)
      VALUES (${largeRemoteRef!.id}::uuid, ${folder!.id}::uuid, ${largeMessage!.id}::uuid, ARRAY[]::text[], ARRAY[]::text[])
    `;
    const hydratedLargeMessage = await hydrateMessageFromSource({
      messageId: largeMessage!.id,
      source: Readable.from([longSource]),
      expectedSize: longSource.length,
    });
    expect(hydratedLargeMessage.status).toBe("hydrated");
    const largePartBlobs = await sql<{ blob_id: string }[]>`
      SELECT blob_id FROM mail.message_parts WHERE message_id = ${largeMessage!.id}::uuid AND blob_id IS NOT NULL
    `;
    ids.blobIds.push(...largePartBlobs.map((row) => row.blob_id));
    const tailSearch = await searchMessages({
      context,
      mailboxId: mailbox.data.id,
      request: {
        expression: { type: "text", field: "body", query: "longtoken109999", match: "words" },
        sort: "relevance",
        limit: 10,
      },
    });
    expect(tailSearch.ok).toBe(true);
    if (tailSearch.ok) expect(tailSearch.data.items.map((item) => item.id)).toContain(largeMessage!.id);

    const firstSearchPage = await searchMessages({
      context,
      mailboxId: mailbox.data.id,
      request: {
        expression: { type: "text", field: "any", query: "body", match: "words" },
        sort: "newest",
        limit: 1,
      },
    });
    expect(firstSearchPage.ok).toBe(true);
    const searchCursor = firstSearchPage.ok ? firstSearchPage.data.nextCursor : null;
    expect(searchCursor).not.toBeNull();
    const secondSearchPage = await searchMessages({
      context,
      mailboxId: mailbox.data.id,
      request: {
        expression: { type: "text", field: "any", query: "body", match: "words" },
        sort: "newest",
        limit: 1,
        cursor: searchCursor ?? undefined,
      },
    });
    expect(secondSearchPage.ok).toBe(true);
    if (firstSearchPage.ok && secondSearchPage.ok) {
      expect(secondSearchPage.data.items).toHaveLength(1);
      expect(secondSearchPage.data.items[0]?.conversationId ?? secondSearchPage.data.items[0]?.id).not.toBe(
        firstSearchPage.data.items[0]?.conversationId ?? firstSearchPage.data.items[0]?.id,
      );
    }
    const reusedSearchCursor = await searchMessages({
      context,
      mailboxId: mailbox.data.id,
      request: {
        expression: { type: "text", field: "any", query: "different query", match: "words" },
        sort: "newest",
        limit: 1,
        cursor: searchCursor ?? undefined,
      },
    });
    expect(reusedSearchCursor.ok).toBe(false);
    const mismatchedBackendCursor = JSON.parse(Buffer.from(searchCursor!, "base64url").toString("utf8")) as Record<string, unknown>;
    mismatchedBackendCursor.backend = "pg_textsearch";
    const changedBackendPage = await searchMessages({
      context,
      mailboxId: mailbox.data.id,
      request: {
        expression: { type: "text", field: "any", query: "body", match: "words" },
        sort: "newest",
        limit: 1,
        cursor: Buffer.from(JSON.stringify(mismatchedBackendCursor)).toString("base64url"),
      },
    });
    expect(changedBackendPage.ok).toBe(false);

    const referencedBlob = await storeReadableBlob(Readable.from([Buffer.from("referenced blob")]), 15);
    const orphanedBlob = await storeReadableBlob(Readable.from([Buffer.from("orphaned blob")]), 13);
    const uploadGuardedBlob = await storeReadableBlob(Readable.from([Buffer.from("upload guarded blob")]), 19);
    const sourceGuardedBlob = await storeReadableBlob(Readable.from([Buffer.from("source guarded blob")]), 19);
    ids.blobIds.push(referencedBlob.id, orphanedBlob.id, uploadGuardedBlob.id, sourceGuardedBlob.id);
    const gcDraft = await createDraft({
      context,
      mailboxId: mailbox.data.id,
      input: {
        intent: "new",
        senderIdentityId: identity!.id,
        to: [],
        cc: [],
        bcc: [],
        subject: "Blob cleanup guard",
        body: "",
        format: "plain",
      },
    });
    if (!gcDraft.ok) throw new Error(gcDraft.error.message);
    await sql`
      INSERT INTO mail.draft_attachment_uploads (
        draft_id, blob_id, filename, content_type, byte_length, received_bytes,
        next_position, state, creator_kind, creator_id
      ) VALUES (
        ${gcDraft.data.id}::uuid,
        ${uploadGuardedBlob.id}::uuid,
        'guarded.txt',
        'text/plain',
        ${uploadGuardedBlob.byteLength},
        ${uploadGuardedBlob.byteLength},
        ${uploadGuardedBlob.chunkCount},
        'uploaded',
        'user',
        ${ids.userIds[0]}::uuid
      )
    `;
    await sql`
      UPDATE mail.message_part_blobs
      SET completed_at = now() - interval '10 minutes'
      WHERE id IN (
        ${referencedBlob.id}::uuid,
        ${orphanedBlob.id}::uuid,
        ${uploadGuardedBlob.id}::uuid,
        ${sourceGuardedBlob.id}::uuid
      )
    `;
    await sql`
      INSERT INTO mail.message_parts (
        message_id, part_path, content_type, size_bytes, blob_id, hydration_status
      ) VALUES (
        ${message!.id}::uuid, 'integration-part', 'text/plain', ${referencedBlob.byteLength}, ${referencedBlob.id}::uuid, 'complete'
      )
    `;
    await sql`
      UPDATE mail.message_contents
      SET source_blob_id = ${sourceGuardedBlob.id}::uuid
      WHERE id = ${message!.id}::uuid
    `;
    expect(await deleteOrphanedBlobs(5)).toBeGreaterThanOrEqual(1);
    const remainingBlobs = await sql<{ id: string }[]>`
      SELECT id
      FROM mail.message_part_blobs
      WHERE id IN (
        ${referencedBlob.id}::uuid,
        ${orphanedBlob.id}::uuid,
        ${uploadGuardedBlob.id}::uuid,
        ${sourceGuardedBlob.id}::uuid
      )
      ORDER BY id
    `;
    expect(remainingBlobs.map((item) => item.id)).toEqual([referencedBlob.id, sourceGuardedBlob.id, uploadGuardedBlob.id].sort());
    await sql`DELETE FROM mail.drafts WHERE id = ${gcDraft.data.id}::uuid`;

    const [collaborator] = await sql<{ id: string }[]>`
      INSERT INTO auth.users (uid, provider, profile, display_name, admin)
      VALUES (${`mail-collaborator-${suffix}`}, 'local', 'user', 'Mail Collaborator', false)
      RETURNING id
    `;
    if (!collaborator) throw new Error("Failed to create collaborator");
    ids.userIds.push(collaborator.id);
    const collaboratorContext: MailRequestContext = {
      actor: {
        kind: "user",
        user: {
          id: collaborator.id,
          uid: `mail-collaborator-${suffix}`,
          provider: "local",
          profile: "user",
          displayName: "Mail Collaborator",
          givenName: "Mail",
          sn: "Collaborator",
          mail: `mail-collaborator-${suffix}@example.com`,
          roles: ["user"],
          memberofGroupIds: [],
          memberofGroups: [],
        } as never,
      },
      accessSubject: { type: "user", userId: collaborator.id },
      requestId: `mail-collaborator-${suffix}`,
    };
    const grant = await grantMailboxAccess({
      context,
      mailboxId: mailbox.data.id,
      principal: { type: "user", userId: collaborator.id },
      permission: "write",
    });
    expect(grant.ok).toBe(true);
    if (!grant.ok) return;
    expect(grant.data.displayName).toBe("Mail Collaborator");
    const accessEntries = await listMailboxAccess(context, mailbox.data.id);
    expect(accessEntries.ok).toBe(true);
    if (!accessEntries.ok) return;
    expect(accessEntries.data.find((entry) => entry.id === grant.data.id)?.displayName).toBe("Mail Collaborator");
    const collaboratorDraft = await createDraft({
      context: collaboratorContext,
      mailboxId: mailbox.data.id,
      input: {
        senderIdentityId: identity!.id,
        to: [{ address: "recipient@example.com" }],
        cc: [],
        bcc: [],
        subject: "Revocation test",
        body: "This must not be sent after access is revoked.",
        format: "plain",
      },
    });
    expect(collaboratorDraft.ok).toBe(true);
    if (!collaboratorDraft.ok) return;
    const collaboratorLease = await acquireDraftLease({
      context: collaboratorContext,
      mailboxId: mailbox.data.id,
      draftId: collaboratorDraft.data.id,
    });
    expect(collaboratorLease.ok).toBe(true);
    expect((await revokeMailboxAccess({ context, mailboxId: mailbox.data.id, accessId: grant.data.id })).ok).toBe(true);
    const leaseAfterRevocation = await getDraftLease({
      context,
      mailboxId: mailbox.data.id,
      draftId: collaboratorDraft.data.id,
    });
    expect(leaseAfterRevocation.ok && leaseAfterRevocation.data).toBeNull();
    const ownerLease = await acquireDraftLease({
      context,
      mailboxId: mailbox.data.id,
      draftId: collaboratorDraft.data.id,
    });
    expect(ownerLease.ok).toBe(true);
    if (ownerLease.ok) {
      expect(
        (
          await releaseDraftLease({
            context,
            mailboxId: mailbox.data.id,
            draftId: collaboratorDraft.data.id,
            token: ownerLease.data.token,
          })
        ).ok,
      ).toBe(true);
    }
    const readGrant = await grantMailboxAccess({
      context,
      mailboxId: mailbox.data.id,
      principal: { type: "user", userId: collaborator.id },
      permission: "read",
    });
    expect(readGrant.ok).toBe(true);
    if (!readGrant.ok) return;
    expect((await getDraft(collaboratorContext, mailbox.data.id, collaboratorDraft.data.id)).ok).toBe(true);
    expect(
      (
        await listConversationDrafts({
          context: collaboratorContext,
          mailboxId: mailbox.data.id,
          conversationId: orderedConversation!.id,
        })
      ).ok,
    ).toBe(true);
    expect(
      (
        await updateDraft({
          context: collaboratorContext,
          mailboxId: mailbox.data.id,
          draftId: collaboratorDraft.data.id,
          expectedRevision: collaboratorDraft.data.revision,
          input: {
            senderIdentityId: identity!.id,
            to: [{ address: "recipient@example.com" }],
            cc: [],
            bcc: [],
            subject: "Read-only mutation must fail",
            body: "Readers must not edit shared drafts.",
            format: "plain",
          },
        })
      ).ok,
    ).toBe(false);
    expect((await revokeMailboxAccess({ context, mailboxId: mailbox.data.id, accessId: readGrant.data.id })).ok).toBe(true);
    const revokedConversationDrafts = await listConversationDrafts({
      context: collaboratorContext,
      mailboxId: mailbox.data.id,
      conversationId: orderedConversation!.id,
    });
    expect(revokedConversationDrafts.ok).toBe(false);
    if (!revokedConversationDrafts.ok) expect(revokedConversationDrafts.error.code).toBe("FORBIDDEN");
    const sendGrant = await grantMailboxAccess({
      context,
      mailboxId: mailbox.data.id,
      principal: { type: "user", userId: collaborator.id },
      permission: "write",
    });
    expect(sendGrant.ok).toBe(true);
    if (!sendGrant.ok) return;
    const collaboratorCommand = await createActorCommand({
      context: collaboratorContext,
      mailboxId: mailbox.data.id,
      input: {
        kind: "send",
        draftId: collaboratorDraft.data.id,
        expectedDraftRevision: collaboratorDraft.data.revision,
        senderIdentityId: identity!.id,
        scheduledAt: new Date(Date.now() + 60 * 60_000).toISOString(),
        undoSeconds: 0,
        idempotencyKey: `revoked-send-${suffix}`,
      },
    });
    expect(collaboratorCommand.ok, collaboratorCommand.ok ? undefined : JSON.stringify(collaboratorCommand.error)).toBe(true);
    if (!collaboratorCommand.ok) return;
    const scheduledDraft = await getDraft(context, mailbox.data.id, collaboratorDraft.data.id);
    expect(scheduledDraft.ok).toBe(true);
    if (scheduledDraft.ok) {
      expect(scheduledDraft.data).toMatchObject({
        state: "scheduled",
        conversationId: collaboratorCommand.data.result.conversationId,
        lastEditedByDisplayName: "Mail Collaborator",
      });
    }
    const collaboratorScheduled = await listScheduledSends({
      context: collaboratorContext,
      mailboxId: mailbox.data.id,
      limit: 100,
    });
    expect(collaboratorScheduled.ok).toBe(true);
    if (collaboratorScheduled.ok) {
      expect(collaboratorScheduled.data.items).toContainEqual(
        expect.objectContaining({
          commandId: collaboratorCommand.data.id,
          draftId: collaboratorDraft.data.id,
          state: "scheduled",
        }),
      );
    }
    expect((await revokeMailboxAccess({ context, mailboxId: mailbox.data.id, accessId: sendGrant.data.id })).ok).toBe(true);
    const revokedScheduled = await listScheduledSends({
      context: collaboratorContext,
      mailboxId: mailbox.data.id,
    });
    expect(revokedScheduled.ok).toBe(false);
    const [collaboratorOutbox] = await sql<{ id: string }[]>`
      UPDATE mail.outbox_submissions
      SET scheduled_at = now() - interval '1 second', undo_until = NULL
      WHERE command_id = ${collaboratorCommand.data.id}::uuid
      RETURNING id
    `;
    const revokedCancellation = await cancelScheduledSend({
      context: collaboratorContext,
      mailboxId: mailbox.data.id,
      scheduledSendId: collaboratorOutbox!.id,
      input: { disposition: "draft" },
    });
    expect(revokedCancellation.ok).toBe(false);
    const [outboxResource] = await sql<{ id: string }[]>`
      SELECT binding.remote_resource_id AS id
      FROM mail.outbox_submissions outbox
      JOIN mail.provider_bindings binding ON binding.id = outbox.selected_binding_id
      WHERE outbox.id = ${collaboratorOutbox!.id}::uuid
    `;
    expect(outboxResource?.id).toBe(resource!.id);
    const outboxLock = await mailProviderOperationMutex().acquire({
      resource: outboxResource!.id,
      ttlMs: MAIL_PROVIDER_OPERATION_LEASE_MS,
    });
    expect(outboxLock).not.toBeNull();
    if (!outboxLock) return;
    try {
      const blockedExecution = await executeOutboxSubmission(collaboratorOutbox!.id).catch((error: unknown) => error);
      expect(blockedExecution).toMatchObject({ code: "REMOTE_RESOURCE_BUSY" });
    } finally {
      await mailProviderOperationMutex().release(outboxLock);
    }

    const preDispatchLeaseFailure = await executeOutboxSubmissionWithHeartbeat(collaboratorOutbox!.id, async () => {
      throw Object.assign(new Error("Synthetic job lease loss before dispatch"), { code: "COMMAND_JOB_LEASE_LOST" });
    }).catch((error: unknown) => error);
    expect(preDispatchLeaseFailure).toMatchObject({ code: "COMMAND_JOB_LEASE_LOST" });
    const [rolledBackClaim] = await sql<
      {
        outbox_state: string;
        command_state: string;
        draft_state: string;
        outbox_attempt: number;
        command_attempt: number;
        worker_heartbeat_at: Date | null;
      }[]
    >`
      SELECT
        o.state AS outbox_state,
        c.state AS command_state,
        d.state AS draft_state,
        o.attempt AS outbox_attempt,
        c.attempt AS command_attempt,
        c.worker_heartbeat_at
      FROM mail.outbox_submissions o
      JOIN mail.commands c ON c.id = o.command_id
      JOIN mail.drafts d ON d.id = o.draft_id
      WHERE o.id = ${collaboratorOutbox!.id}::uuid
    `;
    expect(rolledBackClaim).toEqual({
      outbox_state: "scheduled",
      command_state: "queued",
      draft_state: "scheduled",
      outbox_attempt: 0,
      command_attempt: 0,
      worker_heartbeat_at: null,
    });

    const postEffectLeaseFailure = await executeOutboxSubmissionWithHeartbeat(collaboratorOutbox!.id, async (loaded) => {
      await sql`
        UPDATE mail.commands
        SET provider_effect_started_at = now(), provider_effect_attempt = attempt
        WHERE id = ${loaded.command.id}::uuid
      `;
      throw Object.assign(new Error("Synthetic job lease loss after dispatch started"), { code: "COMMAND_JOB_LEASE_LOST" });
    }).catch((error: unknown) => error);
    expect(postEffectLeaseFailure).toMatchObject({ code: "COMMAND_JOB_LEASE_LOST" });
    const [preservedClaim] = await sql<
      {
        outbox_state: string;
        command_state: string;
        draft_state: string;
        outbox_attempt: number;
        command_attempt: number;
        provider_effect_attempt: number | null;
      }[]
    >`
      SELECT
        o.state AS outbox_state,
        c.state AS command_state,
        d.state AS draft_state,
        o.attempt AS outbox_attempt,
        c.attempt AS command_attempt,
        c.provider_effect_attempt
      FROM mail.outbox_submissions o
      JOIN mail.commands c ON c.id = o.command_id
      JOIN mail.drafts d ON d.id = o.draft_id
      WHERE o.id = ${collaboratorOutbox!.id}::uuid
    `;
    expect(preservedClaim).toEqual({
      outbox_state: "sending",
      command_state: "executing",
      draft_state: "sending",
      outbox_attempt: 1,
      command_attempt: 1,
      provider_effect_attempt: 1,
    });
    await sql.begin(async (tx) => {
      await tx`
        UPDATE mail.outbox_submissions
        SET state = 'scheduled', attempt = 0
        WHERE id = ${collaboratorOutbox!.id}::uuid
      `;
      await tx`
        UPDATE mail.commands
        SET
          state = 'queued',
          attempt = 0,
          started_at = NULL,
          worker_heartbeat_at = NULL,
          provider_effect_started_at = NULL,
          provider_effect_attempt = NULL
        WHERE id = ${collaboratorCommand.data.id}::uuid
      `;
      await tx`UPDATE mail.drafts SET state = 'scheduled' WHERE id = ${collaboratorDraft.data.id}::uuid`;
    });
    expect(await executeOutboxSubmission(collaboratorOutbox!.id)).toBe("failed");
    const [revokedExecution] = await sql<
      {
        outbox_state: string;
        command_state: string;
        draft_state: string;
        error_code: string | null;
        outbox_attempt: number;
        command_attempt: number;
        worker_heartbeat_at: Date | null;
      }[]
    >`
      SELECT
        o.state AS outbox_state,
        c.state AS command_state,
        d.state AS draft_state,
        o.last_error_code AS error_code,
        o.attempt AS outbox_attempt,
        c.attempt AS command_attempt,
        c.worker_heartbeat_at
      FROM mail.outbox_submissions o
      JOIN mail.commands c ON c.id = o.command_id
      JOIN mail.drafts d ON d.id = o.draft_id
      WHERE o.id = ${collaboratorOutbox!.id}::uuid
    `;
    expect(revokedExecution).toEqual({
      outbox_state: "failed",
      command_state: "failed",
      draft_state: "draft",
      error_code: "ACCESS_REVOKED",
      outbox_attempt: 1,
      command_attempt: 1,
      worker_heartbeat_at: null,
    });

    const retryDraft = await createDraft({
      context,
      mailboxId: mailbox.data.id,
      input: {
        senderIdentityId: identity!.id,
        to: [{ address: "recipient@example.com" }],
        cc: [{ address: "remaining@example.com" }],
        bcc: [],
        subject: "Sent copy retry",
        body: "Sent copy retry body",
        format: "plain",
      },
    });
    expect(retryDraft.ok).toBe(true);
    if (!retryDraft.ok) return;
    const retryCommand = await createActorCommand({
      context,
      mailboxId: mailbox.data.id,
      input: {
        kind: "send",
        draftId: retryDraft.data.id,
        expectedDraftRevision: retryDraft.data.revision,
        senderIdentityId: identity!.id,
        scheduledAt: new Date(Date.now() + 60 * 60_000).toISOString(),
        undoSeconds: 0,
        idempotencyKey: `sent-copy-${suffix}`,
      },
    });
    expect(retryCommand.ok).toBe(true);
    if (!retryCommand.ok) return;
    await sql`
      UPDATE mail.provider_connections
      SET encrypted_secret = 'invalid-encrypted-fixture'
      WHERE id = ${connection!.id}::uuid
    `;
    const [retryOutbox] = await sql<{ id: string }[]>`
      UPDATE mail.outbox_submissions
      SET state = 'sent_sync_pending', scheduled_at = now(), undo_until = NULL
      WHERE command_id = ${retryCommand.data.id}::uuid
      RETURNING id
    `;
    await sql`UPDATE mail.commands SET state = 'confirmed', finished_at = now() WHERE id = ${retryCommand.data.id}::uuid`;
    await sql`UPDATE mail.drafts SET state = 'sent' WHERE id = ${retryDraft.data.id}::uuid`;
    expect(await executeOutboxSubmission(retryOutbox!.id)).toBe("sent_sync_pending");
    const [retriedCopy] = await sql<{ state: string; attempt: number; last_error_code: string | null }[]>`
      SELECT state, attempt, last_error_code FROM mail.outbox_submissions WHERE id = ${retryOutbox!.id}::uuid
    `;
    expect(retriedCopy?.state).toBe("sent_sync_pending");
    expect(retriedCopy?.attempt).toBe(1);
    expect(retriedCopy?.last_error_code).toBe("CREDENTIAL_DECRYPTION_FAILED");

    await sql`
      UPDATE mail.provider_connections
      SET encrypted_secret = ${encryptedSecret}
      WHERE id = ${connection!.id}::uuid
    `;
    await sql`
      UPDATE mail.outbox_submissions
      SET state = 'unknown', last_error_code = NULL, last_error_message = NULL
      WHERE id = ${retryOutbox!.id}::uuid
    `;
    await sql`
      UPDATE mail.commands
      SET state = 'ambiguous', finished_at = NULL, worker_heartbeat_at = NULL
      WHERE id = ${retryCommand.data.id}::uuid
    `;
    expect(await executeOutboxSubmission(retryOutbox!.id)).toBe("needs_attention");
    const [reconciledUnknown] = await sql<
      {
        outbox_state: string;
        command_state: string;
        outbox_attempt: number;
        command_attempt: number;
        worker_heartbeat_at: Date | null;
      }[]
    >`
      SELECT
        o.state AS outbox_state,
        c.state AS command_state,
        o.attempt AS outbox_attempt,
        c.attempt AS command_attempt,
        c.worker_heartbeat_at
      FROM mail.outbox_submissions o
      JOIN mail.commands c ON c.id = o.command_id
      WHERE o.id = ${retryOutbox!.id}::uuid
    `;
    expect(reconciledUnknown).toEqual({
      outbox_state: "needs_attention",
      command_state: "needs_attention",
      outbox_attempt: 2,
      command_attempt: 1,
      worker_heartbeat_at: null,
    });
    const ambiguousRecovery = await createDeliveryRecoveryDraft({
      context,
      mailboxId: mailbox.data.id,
      deliveryId: retryOutbox!.id,
      input: {
        recipientMode: "all",
        includeAttachments: true,
        idempotencyKey: `ambiguous-recovery-${suffix}`,
      },
    });
    expect(ambiguousRecovery.ok).toBe(true);
    if (ambiguousRecovery.ok) {
      expect(ambiguousRecovery.data.to).toEqual([{ name: null, address: "recipient@example.com" }]);
      expect(ambiguousRecovery.data.cc).toEqual([{ name: null, address: "remaining@example.com" }]);
    }
    await sql`
      UPDATE mail.outbox_submissions
      SET
        state = 'needs_attention',
        last_error_code = 'SMTP_PARTIAL_ACCEPTANCE',
        provider_response = ${{
          accepted: ["recipient@example.com"],
          rejected: ["remaining@example.com"],
          response: "250 partial",
        }}::jsonb
      WHERE id = ${retryOutbox!.id}::uuid
    `;
    const remainingRecoveryRequest = {
      context,
      mailboxId: mailbox.data.id,
      deliveryId: retryOutbox!.id,
      input: {
        recipientMode: "remaining" as const,
        includeAttachments: true,
        idempotencyKey: `remaining-recovery-${suffix}`,
      },
    };
    const remainingRecovery = await createDeliveryRecoveryDraft(remainingRecoveryRequest);
    expect(remainingRecovery.ok).toBe(true);
    if (remainingRecovery.ok) {
      expect(remainingRecovery.data.to).toEqual([]);
      expect(remainingRecovery.data.cc).toEqual([{ name: null, address: "remaining@example.com" }]);
      expect(remainingRecovery.data.bcc).toEqual([]);
    }
    const repeatedRecovery = await createDeliveryRecoveryDraft(remainingRecoveryRequest);
    expect(repeatedRecovery.ok).toBe(true);
    if (repeatedRecovery.ok && remainingRecovery.ok) expect(repeatedRecovery.data.id).toBe(remainingRecovery.data.id);
    const [exhaustedMutation] = await sql<{ id: string }[]>`
      INSERT INTO mail.commands (
        mailbox_id,
        kind,
        state,
        actor_kind,
        actor_id,
        idempotency_key,
        request_hash,
        target,
        payload,
        selected_binding_id,
        selected_secret_revision,
        rights_snapshot,
        transport_metadata,
        attempt,
        access_subject_kind,
        access_subject_id,
        credential_scopes
      ) VALUES (
        ${mailbox.data.id}::uuid,
        'set_flags',
        'ambiguous',
        'user',
        ${ids.userIds[0]}::uuid,
        ${`exhausted-mutation-${suffix}`},
        ${"c".repeat(64)},
        ${{ remoteMessageRefId: remoteRef!.id, folderId: folder!.id }}::jsonb,
        ${{ flags: ["\\Seen"] }}::jsonb,
        ${binding!.id}::uuid,
        1,
        ${{ folders: { [folder!.id]: ["write_flags"] } }}::jsonb,
        '{}'::jsonb,
        4,
        'user',
        ${ids.userIds[0]}::uuid,
        ARRAY[]::text[]
      ) RETURNING id
    `;
    expect(await executeMutationCommand(exhaustedMutation!.id)).toBe("needs_attention");
    const [exhaustedState] = await sql<{ attempt: number; last_error_code: string | null; worker_heartbeat_at: Date | null }[]>`
      SELECT attempt, last_error_code, worker_heartbeat_at FROM mail.commands WHERE id = ${exhaustedMutation!.id}::uuid
    `;
    expect(exhaustedState).toEqual({
      attempt: 5,
      last_error_code: "AMBIGUOUS_RECONCILIATION_EXHAUSTED",
      worker_heartbeat_at: null,
    });

    const [exhaustedHydration] = await sql<{ id: string; short_id: string }[]>`
      INSERT INTO mail.message_contents (
        short_id,
        mailbox_id,
        message_id,
        subject,
        internal_date,
        size_bytes,
        content_hash,
        hydration_status,
        hydration_attempt
      ) VALUES (
        ${newShortId()},
        ${mailbox.data.id}::uuid,
        '<exhausted-hydration@example.com>',
        'Exhausted hydration',
        now(),
        1,
        ${"d".repeat(64)},
        'failed',
        5
      ) RETURNING id, short_id
    `;
    await expect(
      hydrateMessageFromSource({
        messageId: exhaustedHydration!.id,
        source: Readable.from([Buffer.from("x")]),
        expectedSize: 1,
      }),
    ).rejects.toMatchObject({ code: "HYDRATION_NOT_CLAIMED" });
    const [hydrationState] = await sql<{ hydration_status: string; hydration_attempt: number }[]>`
      SELECT hydration_status, hydration_attempt
      FROM mail.message_contents
      WHERE id = ${exhaustedHydration!.id}::uuid
    `;
    expect(hydrationState).toEqual({ hydration_status: "failed", hydration_attempt: 5 });

    const verify = spyOn(imapSmtpConnector, "verify").mockResolvedValue({
      authenticatedPrincipal: "sender@example.com",
      serverIdentity: { serverInfo: { name: "fixture" } },
      capabilities: {
        idle: true,
        condstore: true,
        qresync: true,
        move: true,
        uidplus: true,
        namespace: true,
        listExtended: true,
        specialUse: true,
        acl: false,
        notify: false,
        quota: false,
        gmailExtensions: false,
      },
      limits: unavailableProviderLimitSnapshot(),
      accounts: [{ id: "sender@example.com", name: "Fixture", locator: {}, namespaces: [] }],
    });
    try {
      verify.mockClear();
      const mailboxCredentialLock = await mailProviderOperationMutex().acquire({
        resource: `mailbox:${mailbox.data.id}`,
        ttlMs: MAIL_PROVIDER_OPERATION_LEASE_MS,
      });
      expect(mailboxCredentialLock).not.toBeNull();
      if (!mailboxCredentialLock) return;
      const creation = createProviderConnection({
        context,
        mailboxId: mailbox.data.id,
        input: {
          name: `Created fixture ${suffix}`,
          email: "created@example.com",
          username: "created@example.com",
          imap: { host: "imap.example.com", port: 993, tlsMode: "implicit" },
          smtp: { host: "smtp.example.com", port: 587, tlsMode: "starttls" },
          secret: { kind: "password", password: "created-secret" },
        },
      });
      let created: Awaited<typeof creation>;
      try {
        await Bun.sleep(100);
        expect(verify).not.toHaveBeenCalled();
      } finally {
        await mailProviderOperationMutex().release(mailboxCredentialLock);
        created = await creation;
      }
      expect(created.ok).toBe(false);
      if (!created.ok) expect(created.error.code).toBe("CONFLICT");
      expect(verify).toHaveBeenCalledTimes(1);

      const credentialLock = await mailProviderOperationMutex().acquire({
        resource: resource!.id,
        ttlMs: MAIL_PROVIDER_OPERATION_LEASE_MS,
      });
      expect(credentialLock).not.toBeNull();
      if (!credentialLock) return;
      verify.mockClear();
      const replacement = replaceProviderConnection({
        context,
        connectionId: connection!.id,
        input: {
          name: "Fixture",
          email: "sender@example.com",
          username: "sender@example.com",
          imap: { host: "imap.example.com", port: 993, tlsMode: "implicit" },
          smtp: { host: "smtp.example.com", port: 587, tlsMode: "starttls" },
          secret: { kind: "password", password: "replacement-secret" },
        },
      });
      let replaced: Awaited<typeof replacement>;
      try {
        await Bun.sleep(100);
        const [beforeCredentialRelease] = await sql<{ secret_revision: number }[]>`
          SELECT secret_revision FROM mail.provider_connections WHERE id = ${connection!.id}::uuid
        `;
        expect(beforeCredentialRelease?.secret_revision).toBe(1);
        expect(verify).not.toHaveBeenCalled();
      } finally {
        await mailProviderOperationMutex().release(credentialLock);
        replaced = await replacement;
      }
      expect(replaced.ok).toBe(true);
      expect(verify).toHaveBeenCalledTimes(1);
    } finally {
      verify.mockRestore();
    }
    const [credentialState] = await sql<
      {
        secret_revision: number;
        binding_state: string;
        verified_secret_revision: number;
        sender_revoked: boolean;
        identity_status: string;
        resource_status: string;
        mailbox_health: string;
      }[]
    >`
      SELECT
        pc.secret_revision,
        pb.state AS binding_state,
        pb.verified_secret_revision,
        sib.revoked_at IS NOT NULL AS sender_revoked,
        si.status AS identity_status,
        rr.status AS resource_status,
        m.health AS mailbox_health
      FROM mail.provider_connections pc
      JOIN mail.provider_bindings pb ON pb.connection_id = pc.id
      JOIN mail.sender_identity_bindings sib ON sib.binding_id = pb.id
      JOIN mail.sender_identities si ON si.id = sib.sender_identity_id
      JOIN mail.remote_resources rr ON rr.id = pb.remote_resource_id
      JOIN mail.mailboxes m ON m.id = rr.mailbox_id
      WHERE pc.id = ${connection!.id}::uuid
    `;
    expect(credentialState).toEqual({
      secret_revision: 2,
      binding_state: "pending",
      verified_secret_revision: 1,
      sender_revoked: true,
      identity_status: "unverified",
      resource_status: "connection_required",
      mailbox_health: "connection_required",
    });
    const unavailableExecution = await resolveMailExecution({
      context,
      mailboxId: mailbox.data.id,
      operation: "actorMutation",
    });
    expect(unavailableExecution.ok).toBe(false);
    if (!unavailableExecution.ok) {
      expect(unavailableExecution.error.message).toBe(
        "Mailbox transport is unavailable: Provider credentials changed; verify the remote resource again",
      );
    }
  }, 30_000);
});
