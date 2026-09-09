import { err, fail, i18n, isServiceError, ok, type Result } from "@k2b/stdlib";
import { audit } from "@k2b/cloud/services";
import { sql } from "bun";
import { z } from "zod";
import {
  type CreateSenderIdentityInput,
  createSenderIdentityInputSchema,
  type DefaultSenderSetupInput,
  defaultSenderSetupInputSchema,
  type MailAddress,
  type MailComposeFormat,
  type MailPriority,
  parseProviderLimitSnapshot,
  type SenderIdentity,
  type SmtpTransportCapabilities,
  smtpTransportCapabilitiesSchema,
  type UpdateSenderIdentityInput,
} from "../contracts";

const verificationMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      subject: "Cloud Mail sender identity verification",
      body: ({ address }: { address: string }) => `Cloud Mail verified that ${address} can be submitted through this provider binding.`,
    },
    de: {
      subject: "Bestätigung der Absenderidentität in Cloud Mail",
      body: ({ address }) => `Cloud Mail hat bestätigt, dass ${address} über diese Anbieterverbindung versendet werden kann.`,
    },
  },
});
import { withShortIdDb } from "../lib/short-id";
import { requireMailboxPermission } from "./access";
import { normalizeEmailAddress } from "./address-normalization";
import { auditActorFromRequest, type MailRequestContext } from "./auth";
import { imapSmtpConnector } from "./connectors";
import { resolveRoleFolder } from "./folders";
import { validateDestructiveIncomingAutomationsForMailbox } from "./incoming-automations";
import { loadProviderConnectionRuntimeSnapshot } from "./provider-connections";
import { withMailboxProviderOperationBarrier } from "./provider-operation-lock";

const internalCreateSenderIdentityInputSchema = createSenderIdentityInputSchema.extend({
  defaultSignatureTemplateId: z.string().uuid().nullable().optional(),
  sentFolderId: z.string().uuid().nullable().optional(),
  draftsFolderId: z.string().uuid().nullable().optional(),
});

type DbIdentity = {
  id: string;
  mailbox_id: string;
  label: string;
  display_name: string;
  from_address: string;
  reply_to: string | null;
  default_cc: MailAddress[] | string;
  default_bcc: MailAddress[] | string;
  default_format: MailComposeFormat;
  default_priority: MailPriority;
  default_delivery_receipt: boolean;
  default_read_receipt: boolean;
  vcard: string | null;
  envelope_sender: string | null;
  default_signature_template_id: string | null;
  automation_policy: "disabled" | "mailbox";
  sent_folder_id: string | null;
  drafts_folder_id: string | null;
  is_default: boolean;
  status: SenderIdentity["status"];
  transport_host: string | null;
  transport_port: number | null;
  transport_tls_mode: "implicit" | "starttls" | null;
  transport_username: string | null;
  transport_secret_kind: "password" | "oauth2" | null;
  transport_secret_is_set: boolean;
  transport_revision: number | null;
  transport_status: "active" | "degraded" | "revoked" | null;
  transport_capabilities: SmtpTransportCapabilities | string | null;
  transport_last_verified_at: Date | string | null;
  transport_last_error_message: string | null;
  mailbox_limit_snapshot: unknown;
  created_at: Date | string;
  updated_at: Date | string;
};

type SqlClient = typeof sql;

type DbSenderVerification = DbIdentity & {
  connection_id: string;
  connection_username: string;
  secret_revision: number;
  authenticated_principal: string | null;
  remote_resource_id: string;
};

const identityColumns = sql`
  si.id,
  si.mailbox_id,
  si.label,
  si.display_name,
  si.from_address,
  si.reply_to,
  si.default_cc,
  si.default_bcc,
  si.default_format,
  si.default_priority,
  si.default_delivery_receipt,
  si.default_read_receipt,
  si.vcard,
  si.envelope_sender,
  (
    SELECT signature_default.template_id
    FROM mail.compose_signature_defaults signature_default
    WHERE signature_default.mailbox_id = si.mailbox_id
      AND signature_default.sender_identity_id = si.id
      AND signature_default.user_id IS NULL
  ) AS default_signature_template_id,
  si.automation_policy,
  si.sent_folder_id,
  si.drafts_folder_id,
  si.is_default,
  si.status,
  (SELECT transport.host FROM mail.sender_identity_transports transport WHERE transport.sender_identity_id = si.id) AS transport_host,
  (SELECT transport.port FROM mail.sender_identity_transports transport WHERE transport.sender_identity_id = si.id) AS transport_port,
  (SELECT transport.tls_mode FROM mail.sender_identity_transports transport WHERE transport.sender_identity_id = si.id) AS transport_tls_mode,
  (SELECT transport.username FROM mail.sender_identity_transports transport WHERE transport.sender_identity_id = si.id) AS transport_username,
  (SELECT transport.secret_kind FROM mail.sender_identity_transports transport WHERE transport.sender_identity_id = si.id) AS transport_secret_kind,
  COALESCE((SELECT transport.encrypted_secret IS NOT NULL FROM mail.sender_identity_transports transport WHERE transport.sender_identity_id = si.id), false) AS transport_secret_is_set,
  (SELECT transport.revision FROM mail.sender_identity_transports transport WHERE transport.sender_identity_id = si.id) AS transport_revision,
  (SELECT transport.status FROM mail.sender_identity_transports transport WHERE transport.sender_identity_id = si.id) AS transport_status,
  (SELECT transport.capabilities FROM mail.sender_identity_transports transport WHERE transport.sender_identity_id = si.id) AS transport_capabilities,
  (SELECT transport.last_verified_at FROM mail.sender_identity_transports transport WHERE transport.sender_identity_id = si.id) AS transport_last_verified_at,
  (SELECT transport.last_error_message FROM mail.sender_identity_transports transport WHERE transport.sender_identity_id = si.id) AS transport_last_error_message,
  (
    SELECT connection.limit_snapshot
    FROM mail.provider_connections connection
    WHERE connection.owner_mailbox_id = si.mailbox_id
      AND connection.status = 'active'
    LIMIT 1
  ) AS mailbox_limit_snapshot,
  si.created_at,
  si.updated_at
`;

const parseTransportCapabilities = (value: DbIdentity["transport_capabilities"]): SmtpTransportCapabilities => {
  if (!value) return { dsn: false, size: false, maxMessageBytes: null };
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    return smtpTransportCapabilitiesSchema.parse(parsed);
  } catch {
    return { dsn: false, size: false, maxMessageBytes: null };
  }
};

const mailboxTransportCapabilities = (value: unknown): SmtpTransportCapabilities => {
  const smtp = parseProviderLimitSnapshot(value).smtp;
  return {
    dsn: smtp.dsn,
    size: smtp.status === "supported",
    maxMessageBytes: smtp.maxMessageBytes,
  };
};

const mapIdentity = (row: DbIdentity): SenderIdentity => ({
  id: row.id,
  mailboxId: row.mailbox_id,
  label: row.label,
  displayName: row.display_name,
  fromAddress: row.from_address,
  replyTo: row.reply_to,
  defaultCc: typeof row.default_cc === "string" ? (JSON.parse(row.default_cc) as MailAddress[]) : row.default_cc,
  defaultBcc: typeof row.default_bcc === "string" ? (JSON.parse(row.default_bcc) as MailAddress[]) : row.default_bcc,
  defaultFormat: row.default_format,
  defaultPriority: row.default_priority,
  defaultDeliveryReceipt: row.default_delivery_receipt,
  defaultReadReceipt: row.default_read_receipt,
  vcard: row.vcard,
  envelopeSender: row.envelope_sender,
  defaultSignatureTemplateId: row.default_signature_template_id,
  transport: row.transport_host
    ? {
        mode: "custom",
        host: row.transport_host,
        port: row.transport_port,
        tlsMode: row.transport_tls_mode,
        username: row.transport_username,
        secret: { kind: row.transport_secret_kind, isSet: row.transport_secret_is_set },
        revision: row.transport_revision ?? 0,
        status: row.transport_status ?? "revoked",
        capabilities: parseTransportCapabilities(row.transport_capabilities),
        lastVerifiedAt: row.transport_last_verified_at
          ? (row.transport_last_verified_at instanceof Date
              ? row.transport_last_verified_at
              : new Date(row.transport_last_verified_at)
            ).toISOString()
          : null,
        lastError: row.transport_last_error_message,
      }
    : {
        mode: "mailbox",
        host: null,
        port: null,
        tlsMode: null,
        username: null,
        secret: { kind: null, isSet: false },
        revision: 0,
        status: "active",
        capabilities: mailboxTransportCapabilities(row.mailbox_limit_snapshot),
        lastVerifiedAt: null,
        lastError: null,
      },
  authenticationPolicy: { automation: row.automation_policy },
  sentFolderId: row.sent_folder_id,
  draftsFolderId: row.drafts_folder_id,
  isDefault: row.is_default,
  status: row.status,
  createdAt: (row.created_at instanceof Date ? row.created_at : new Date(row.created_at)).toISOString(),
  updatedAt: (row.updated_at instanceof Date ? row.updated_at : new Date(row.updated_at)).toISOString(),
});

const mapIdentities = (rows: DbIdentity[]): SenderIdentity[] => rows.map(mapIdentity);

const normalizeAddresses = (addresses: MailAddress[]): MailAddress[] => {
  const normalized = new Map<string, MailAddress>();
  for (const address of addresses) {
    const key = normalizeEmailAddress(address.address) ?? address.address.trim().toLowerCase();
    if (!normalized.has(key)) {
      normalized.set(key, {
        ...(address.name?.trim() ? { name: address.name.trim() } : {}),
        address: key,
      });
    }
  }
  return [...normalized.values()];
};

const setMailboxDefaultSignature = async (params: {
  db: SqlClient;
  mailboxId: string;
  senderIdentityId: string;
  templateId: string | null | undefined;
}): Promise<Result<void>> => {
  if (params.templateId === undefined) return ok();
  if (params.templateId === null) {
    await params.db`
      DELETE FROM mail.compose_signature_defaults
      WHERE mailbox_id = ${params.mailboxId}::uuid
        AND sender_identity_id = ${params.senderIdentityId}::uuid
        AND user_id IS NULL
    `;
    return ok();
  }
  const [template] = await params.db<{ id: string }[]>`
    SELECT id
    FROM mail.compose_templates
    WHERE id = ${params.templateId}::uuid
      AND mailbox_id = ${params.mailboxId}::uuid
      AND kind = 'signature'
      AND scope = 'mailbox'
      AND archived_at IS NULL
    FOR SHARE
  `;
  if (!template) return fail(err.badInput("The selected mailbox signature is not available"));
  await params.db`
    INSERT INTO mail.compose_signature_defaults (
      mailbox_id, sender_identity_id, user_id, template_id, revision, updated_at
    ) VALUES (
      ${params.mailboxId}::uuid,
      ${params.senderIdentityId}::uuid,
      NULL,
      ${template.id}::uuid,
      1,
      now()
    )
    ON CONFLICT (mailbox_id, sender_identity_id) WHERE user_id IS NULL
    DO UPDATE SET
      template_id = EXCLUDED.template_id,
      revision = mail.compose_signature_defaults.revision + 1,
      updated_at = now()
  `;
  return ok();
};

const loadSenderVerification = async (params: {
  mailboxId: string;
  senderIdentityId: string;
  bindingId: string;
  db?: typeof sql;
  lock?: boolean;
}): Promise<DbSenderVerification | null> => {
  const db = params.db ?? sql;
  const lockClause = params.lock ? sql`FOR UPDATE OF si, rr, pb, pc` : sql``;
  const [record] = await db<DbSenderVerification[]>`
    SELECT
      ${identityColumns},
      pb.connection_id,
      pc.username AS connection_username,
      pc.secret_revision,
      pb.authenticated_principal,
      rr.id AS remote_resource_id
    FROM mail.sender_identities si
    JOIN mail.remote_resources rr ON rr.mailbox_id = si.mailbox_id
    JOIN mail.mailboxes mailbox ON mailbox.id = si.mailbox_id
    JOIN mail.provider_bindings pb ON pb.remote_resource_id = rr.id
    JOIN mail.provider_connections pc ON pc.id = pb.connection_id
    WHERE si.id = ${params.senderIdentityId}::uuid
      AND si.mailbox_id = ${params.mailboxId}::uuid
      AND pb.id = ${params.bindingId}::uuid
      AND pb.state = 'active'
      AND pb.verified_scope_fingerprint = rr.scope_fingerprint
      AND pb.verified_secret_revision = pc.secret_revision
      AND pc.status = 'active'
      AND pc.encrypted_secret IS NOT NULL
      AND pc.owner_mailbox_id = ${params.mailboxId}::uuid
      AND rr.status = 'active'
      AND mailbox.deleted_at IS NULL
      AND si.status <> 'disabled'
    ${lockClause}
  `;
  return record ?? null;
};

const foldersBelongToMailbox = async (mailboxId: string, folderIds: Array<string | null | undefined>, db: typeof sql): Promise<boolean> => {
  const ids = folderIds.filter((id): id is string => Boolean(id));
  if (ids.length === 0) return true;
  const [row] = await db<{ count: number }[]>`
    SELECT COUNT(*)::int AS count
    FROM mail.folders f
    JOIN mail.remote_resources rr ON rr.id = f.remote_resource_id
    WHERE rr.mailbox_id = ${mailboxId}::uuid
      AND f.id IN (SELECT value::uuid FROM jsonb_array_elements_text(${ids}::jsonb))
  `;
  return row?.count === new Set(ids).size;
};

const requireLockedMailboxAdmin = async (context: MailRequestContext, mailboxId: string, db: SqlClient) => {
  const [mailbox] = await db<{ id: string }[]>`
    SELECT id
    FROM mail.mailboxes
    WHERE id = ${mailboxId}::uuid AND deleted_at IS NULL
    FOR UPDATE
  `;
  if (!mailbox) return fail(err.notFound("Mailbox"));
  return requireMailboxPermission(context, mailboxId, "admin", db);
};

export const createSenderIdentity = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  input: CreateSenderIdentityInput;
}): Promise<Result<SenderIdentity>> => {
  const parsed = internalCreateSenderIdentityInputSchema.safeParse(params.input);
  if (!parsed.success) return fail(err.badInput(parsed.error.issues[0]?.message ?? "Invalid sender identity"));
  try {
    return await sql.begin(async (tx) => {
      const allowed = await requireLockedMailboxAdmin(params.context, params.mailboxId, tx);
      if (!allowed.ok) return allowed;
      const sentFolderId = parsed.data.sentFolderId ? parsed.data.sentFolderId : null;
      const draftsFolderId = parsed.data.draftsFolderId ? parsed.data.draftsFolderId : null;
      if ((parsed.data.sentFolderId && !sentFolderId) || (parsed.data.draftsFolderId && !draftsFolderId)) {
        return fail(err.badInput("Sender identity folder mapping does not belong to this mailbox"));
      }
      const fromAddress = normalizeEmailAddress(parsed.data.fromAddress) ?? parsed.data.fromAddress.trim().toLowerCase();
      const existingIdentities = await tx<{ from_address: string }[]>`
        SELECT from_address
        FROM mail.sender_identities
        WHERE mailbox_id = ${params.mailboxId}::uuid AND status <> 'disabled'
      `;
      const safe = await validateDestructiveIncomingAutomationsForMailbox({
        mailboxId: params.mailboxId,
        identityAddresses: [...existingIdentities.map((identity) => identity.from_address), fromAddress],
        db: tx,
      });
      if (!safe.ok) return safe;
      if (!(await foldersBelongToMailbox(params.mailboxId, [sentFolderId, draftsFolderId], tx))) {
        return fail(err.badInput("Sender identity folder mapping does not belong to this mailbox"));
      }
      const [count] = await tx<{ count: number }[]>`
        SELECT COUNT(*)::int AS count FROM mail.sender_identities WHERE mailbox_id = ${params.mailboxId}::uuid AND status <> 'disabled'
      `;
      const isDefault = parsed.data.isDefault ?? (count?.count ?? 0) === 0;
      if (isDefault) {
        await tx`UPDATE mail.sender_identities SET is_default = false WHERE mailbox_id = ${params.mailboxId}::uuid`;
      }
      const rows = await withShortIdDb(
        tx,
        "senderIdentity",
        (db, shortId) => db<DbIdentity[]>`
        INSERT INTO mail.sender_identities AS si (
          short_id,
          mailbox_id,
          label,
          display_name,
          from_address,
          reply_to,
          default_cc,
          default_bcc,
          default_format,
          default_priority,
          default_delivery_receipt,
          default_read_receipt,
          vcard,
          envelope_sender,
          automation_policy,
          sent_folder_id,
          drafts_folder_id,
          is_default,
          status
        )
        VALUES (
          ${shortId},
          ${params.mailboxId}::uuid,
          ${parsed.data.label},
          ${parsed.data.displayName},
          ${fromAddress},
          ${parsed.data.replyTo ? (normalizeEmailAddress(parsed.data.replyTo) ?? parsed.data.replyTo.trim().toLowerCase()) : null},
          ${normalizeAddresses(parsed.data.defaultCc)}::jsonb,
          ${normalizeAddresses(parsed.data.defaultBcc)}::jsonb,
          ${parsed.data.defaultFormat},
          ${parsed.data.defaultPriority},
          ${parsed.data.defaultDeliveryReceipt},
          ${parsed.data.defaultReadReceipt},
          ${parsed.data.vcard ?? null},
          ${
            parsed.data.envelopeSender
              ? (normalizeEmailAddress(parsed.data.envelopeSender) ?? parsed.data.envelopeSender.trim().toLowerCase())
              : null
          },
          ${parsed.data.authenticationPolicy.automation},
          ${sentFolderId}::uuid,
          ${draftsFolderId}::uuid,
          ${isDefault},
          'unverified'
        )
        RETURNING ${identityColumns}
      `,
      );
      const [row] = rows;
      if (!row) throw new Error("Sender identity insert returned no row");
      const signature = await setMailboxDefaultSignature({
        db: tx,
        mailboxId: params.mailboxId,
        senderIdentityId: row.id,
        templateId: parsed.data.defaultSignatureTemplateId,
      });
      if (!signature.ok) throw signature.error;
      const [created] = await tx<DbIdentity[]>`
        SELECT ${identityColumns}
        FROM mail.sender_identities si
        WHERE si.id = ${row.id}::uuid
      `;
      if (!created) throw new Error("Created sender identity could not be reloaded");
      await audit.record(
        {
          action: "mail.sender_identity.create",
          outcome: "allowed",
          actor: auditActorFromRequest(params.context),
          target: { type: "sender_identity", id: created.id, label: created.label },
          requestId: params.context.requestId,
          metadata: {
            mailboxId: params.mailboxId,
            fromAddress: created.from_address,
            authenticationPolicy: parsed.data.authenticationPolicy,
          },
        },
        tx,
      );
      return ok(mapIdentity(created));
    });
  } catch (error) {
    if ((error as { code?: string } | null)?.code === "23505") return fail(err.conflict("Sender identity"));
    if (isServiceError(error)) return fail(error);
    return fail(err.internal("Failed to create sender identity"));
  }
};

export const listSenderIdentities = async (context: MailRequestContext, mailboxId: string): Promise<Result<SenderIdentity[]>> => {
  const allowed = await requireMailboxPermission(context, mailboxId, "read");
  if (!allowed.ok) return allowed;
  const rows = await sql<DbIdentity[]>`
    SELECT ${identityColumns}
    FROM mail.sender_identities si
    WHERE si.mailbox_id = ${mailboxId}::uuid AND si.status <> 'disabled'
    ORDER BY si.is_default DESC, lower(si.label), si.id
  `;
  return ok(mapIdentities(rows));
};

export const updateSenderIdentity = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  senderIdentityId: string;
  input: UpdateSenderIdentityInput;
}): Promise<Result<SenderIdentity>> => {
  const parsed = { data: params.input };
  try {
    return await sql.begin(async (tx) => {
      const permission = await requireLockedMailboxAdmin(params.context, params.mailboxId, tx);
      if (!permission.ok) return permission;
      const [current] = await tx<DbIdentity[]>`
        SELECT ${identityColumns}
        FROM mail.sender_identities si
        WHERE si.id = ${params.senderIdentityId}::uuid
          AND si.mailbox_id = ${params.mailboxId}::uuid
        FOR UPDATE OF si
      `;
      if (!current) return fail(err.notFound("Sender identity"));
      const nextPolicy = parsed.data.authenticationPolicy ?? { automation: current.automation_policy };
      const sentFolderId =
        parsed.data.sentFolderId === undefined
          ? current.sent_folder_id
          : parsed.data.sentFolderId === null
            ? null
            : parsed.data.sentFolderId;
      const draftsFolderId =
        parsed.data.draftsFolderId === undefined
          ? current.drafts_folder_id
          : parsed.data.draftsFolderId === null
            ? null
            : parsed.data.draftsFolderId;
      if ((parsed.data.sentFolderId && !sentFolderId) || (parsed.data.draftsFolderId && !draftsFolderId)) {
        return fail(err.badInput("Sender identity folder mapping does not belong to this mailbox"));
      }
      if (!(await foldersBelongToMailbox(params.mailboxId, [sentFolderId, draftsFolderId], tx))) {
        return fail(err.badInput("Sender identity folder mapping does not belong to this mailbox"));
      }
      const fromAddress = parsed.data.fromAddress
        ? (normalizeEmailAddress(parsed.data.fromAddress) ?? parsed.data.fromAddress.trim().toLowerCase())
        : current.from_address;
      const replyTo =
        parsed.data.replyTo === undefined
          ? current.reply_to
          : parsed.data.replyTo
            ? (normalizeEmailAddress(parsed.data.replyTo) ?? parsed.data.replyTo.trim().toLowerCase())
            : null;
      const envelopeSender =
        parsed.data.envelopeSender === undefined
          ? current.envelope_sender
          : parsed.data.envelopeSender
            ? (normalizeEmailAddress(parsed.data.envelopeSender) ?? parsed.data.envelopeSender.trim().toLowerCase())
            : null;
      const defaultCc =
        parsed.data.defaultCc === undefined
          ? typeof current.default_cc === "string"
            ? (JSON.parse(current.default_cc) as MailAddress[])
            : current.default_cc
          : normalizeAddresses(parsed.data.defaultCc);
      const defaultBcc =
        parsed.data.defaultBcc === undefined
          ? typeof current.default_bcc === "string"
            ? (JSON.parse(current.default_bcc) as MailAddress[])
            : current.default_bcc
          : normalizeAddresses(parsed.data.defaultBcc);
      const providerRelevantChanged =
        fromAddress !== current.from_address ||
        replyTo !== current.reply_to ||
        envelopeSender !== current.envelope_sender ||
        sentFolderId !== current.sent_folder_id ||
        draftsFolderId !== current.drafts_folder_id;
      const automationPolicyChanged = nextPolicy.automation !== current.automation_policy;
      if (fromAddress !== current.from_address) {
        const identities = await tx<{ id: string; from_address: string }[]>`
          SELECT id, from_address
          FROM mail.sender_identities
          WHERE mailbox_id = ${params.mailboxId}::uuid AND status <> 'disabled'
        `;
        const safe = await validateDestructiveIncomingAutomationsForMailbox({
          mailboxId: params.mailboxId,
          identityAddresses: identities.map((identity) => (identity.id === current.id ? fromAddress : identity.from_address)),
          db: tx,
        });
        if (!safe.ok) return safe;
      }
      if (parsed.data.isDefault === true) {
        await tx`
          UPDATE mail.sender_identities
          SET is_default = false
          WHERE mailbox_id = ${params.mailboxId}::uuid AND id <> ${current.id}::uuid
        `;
      }
      if (providerRelevantChanged) {
        await tx`
          UPDATE mail.sender_identity_bindings
          SET revoked_at = COALESCE(revoked_at, now()), last_error_code = 'IDENTITY_CONFIGURATION_CHANGED'
          WHERE sender_identity_id = ${current.id}::uuid AND revoked_at IS NULL
        `;
      }
      const signature = await setMailboxDefaultSignature({
        db: tx,
        mailboxId: params.mailboxId,
        senderIdentityId: current.id,
        templateId: parsed.data.defaultSignatureTemplateId,
      });
      if (!signature.ok) throw signature.error;
      const [updated] = await tx<DbIdentity[]>`
        UPDATE mail.sender_identities si
        SET
          label = ${parsed.data.label ?? current.label},
          display_name = ${parsed.data.displayName ?? current.display_name},
          from_address = ${fromAddress},
          reply_to = ${replyTo},
          default_cc = ${defaultCc}::jsonb,
          default_bcc = ${defaultBcc}::jsonb,
          default_format = ${parsed.data.defaultFormat ?? current.default_format},
          default_priority = ${parsed.data.defaultPriority ?? current.default_priority},
          default_delivery_receipt = ${parsed.data.defaultDeliveryReceipt ?? current.default_delivery_receipt},
          default_read_receipt = ${parsed.data.defaultReadReceipt ?? current.default_read_receipt},
          vcard = ${parsed.data.vcard === undefined ? current.vcard : parsed.data.vcard},
          envelope_sender = ${envelopeSender},
          automation_policy = ${nextPolicy.automation},
          sent_folder_id = ${sentFolderId}::uuid,
          drafts_folder_id = ${draftsFolderId}::uuid,
          is_default = ${parsed.data.isDefault ?? current.is_default},
          status = CASE WHEN ${providerRelevantChanged} THEN 'unverified' ELSE status END,
          last_provider_rejection = CASE WHEN ${providerRelevantChanged} THEN NULL ELSE last_provider_rejection END
        WHERE si.id = ${current.id}::uuid
        RETURNING ${identityColumns}
      `;
      if (!updated) return fail(err.internal("Sender identity update returned no row"));
      const [reloaded] = await tx<DbIdentity[]>`
        SELECT ${identityColumns}
        FROM mail.sender_identities si
        WHERE si.id = ${updated.id}::uuid
      `;
      if (!reloaded) return fail(err.internal("Updated sender identity could not be reloaded"));
      await audit.record(
        {
          action: "mail.sender_identity.update",
          outcome: "allowed",
          actor: auditActorFromRequest(params.context),
          target: { type: "sender_identity", id: reloaded.id, label: reloaded.label },
          requestId: params.context.requestId,
          metadata: {
            mailboxId: params.mailboxId,
            fromAddress: reloaded.from_address,
            providerRelevantChanged,
            automationPolicyChanged,
          },
        },
        tx,
      );
      return ok(mapIdentity(reloaded));
    });
  } catch (error) {
    if ((error as { code?: string } | null)?.code === "23505") return fail(err.conflict("Sender identity"));
    if (isServiceError(error)) return fail(error);
    return fail(err.internal("Failed to update sender identity"));
  }
};

export const disableSenderIdentity = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  senderIdentityId: string;
}): Promise<Result<void>> => {
  try {
    return await sql.begin(async (tx) => {
      const permission = await requireLockedMailboxAdmin(params.context, params.mailboxId, tx);
      if (!permission.ok) return permission;
      const [disabled] = await tx<{ id: string; from_address: string }[]>`
        UPDATE mail.sender_identities
        SET status = 'disabled', is_default = false
        WHERE id = ${params.senderIdentityId}::uuid
          AND mailbox_id = ${params.mailboxId}::uuid
          AND status <> 'disabled'
        RETURNING id, from_address
      `;
      if (!disabled) return fail(err.notFound("Sender identity"));
      await tx`
        UPDATE mail.sender_identity_bindings
        SET revoked_at = COALESCE(revoked_at, now()), last_error_code = 'IDENTITY_DISABLED'
        WHERE sender_identity_id = ${disabled.id}::uuid AND revoked_at IS NULL
      `;
      await tx`
        UPDATE mail.sender_identities
        SET is_default = true
        WHERE id = (
          SELECT id FROM mail.sender_identities
          WHERE mailbox_id = ${params.mailboxId}::uuid AND status = 'verified'
          ORDER BY created_at, id LIMIT 1
        )
        AND NOT EXISTS (
          SELECT 1 FROM mail.sender_identities
          WHERE mailbox_id = ${params.mailboxId}::uuid AND is_default AND status <> 'disabled'
        )
      `;
      await audit.record(
        {
          action: "mail.sender_identity.disable",
          outcome: "allowed",
          actor: auditActorFromRequest(params.context),
          target: { type: "sender_identity", id: disabled.id, label: disabled.from_address },
          requestId: params.context.requestId,
          metadata: { mailboxId: params.mailboxId },
        },
        tx,
      );
      return ok();
    });
  } catch {
    return fail(err.internal("Failed to disable sender identity"));
  }
};

export const setupDefaultSender = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  input: DefaultSenderSetupInput;
}): Promise<Result<SenderIdentity>> => {
  const parsed = defaultSenderSetupInputSchema.safeParse(params.input);
  if (!parsed.success) return fail(err.badInput(parsed.error.issues[0]?.message ?? "Invalid default sender setup"));
  const permission = await requireMailboxPermission(params.context, params.mailboxId, "admin");
  if (!permission.ok) return permission;
  const [binding] = await sql<
    {
      connection_id: string;
      email: string;
      current_verification: boolean;
    }[]
  >`
    SELECT
      binding.connection_id,
      connection.email,
      EXISTS (
        SELECT 1
        FROM mail.sender_identities identity
        JOIN mail.sender_identity_bindings identity_binding ON identity_binding.sender_identity_id = identity.id
        WHERE identity.mailbox_id = ${params.mailboxId}::uuid
          AND lower(identity.from_address) = lower(connection.email)
          AND identity.status = 'verified'
          AND identity_binding.binding_id = binding.id
          AND identity_binding.verified_secret_revision = connection.secret_revision
          AND identity_binding.saves_sent_automatically = ${parsed.data.savesSentAutomatically}
          AND identity_binding.revoked_at IS NULL
      ) AS current_verification
    FROM mail.provider_bindings binding
    JOIN mail.remote_resources resource ON resource.id = binding.remote_resource_id
    JOIN mail.provider_connections connection ON connection.id = binding.connection_id
    WHERE binding.id = ${parsed.data.bindingId}::uuid
      AND resource.mailbox_id = ${params.mailboxId}::uuid
      AND binding.state = 'active'
      AND binding.verified_secret_revision = connection.secret_revision
      AND connection.status = 'active'
      AND connection.encrypted_secret IS NOT NULL
      AND connection.owner_mailbox_id = ${params.mailboxId}::uuid
  `;
  if (!binding) return fail(err.notFound("Active provider binding"));
  const sent = parsed.data.savesSentAutomatically ? null : await resolveRoleFolder(params.mailboxId, "sent");
  if (sent && !sent.ok) return sent;
  const drafts = await resolveRoleFolder(params.mailboxId, "drafts");
  const sentFolderId = sent?.ok ? sent.data.id : null;
  const draftsFolderId = drafts.ok ? drafts.data.id : null;
  const [existing] = await sql<DbIdentity[]>`
    SELECT ${identityColumns}
    FROM mail.sender_identities si
    WHERE si.mailbox_id = ${params.mailboxId}::uuid
      AND lower(si.from_address) = lower(${binding.email})
      AND si.status <> 'disabled'
    ORDER BY si.is_default DESC, si.created_at, si.id
    LIMIT 1
  `;
  let identity: Result<SenderIdentity>;
  if (existing) {
    identity = await updateSenderIdentity({
      context: params.context,
      mailboxId: params.mailboxId,
      senderIdentityId: existing.id,
      input: {
        ...(parsed.data.label !== undefined ? { label: parsed.data.label } : {}),
        ...(parsed.data.displayName !== undefined ? { displayName: parsed.data.displayName } : {}),
        sentFolderId,
        draftsFolderId,
        isDefault: true,
      },
    });
  } else {
    identity = await createSenderIdentity({
      context: params.context,
      mailboxId: params.mailboxId,
      input: {
        label: parsed.data.label ?? (parsed.data.displayName?.trim() || binding.email),
        displayName: parsed.data.displayName ?? "",
        fromAddress: binding.email,
        defaultCc: [],
        authenticationPolicy: { automation: "mailbox" },
        sentFolderId,
        draftsFolderId,
        isDefault: true,
      },
    });
  }
  if (!identity.ok) return identity;
  if (binding.current_verification && identity.data.status === "verified") return identity;
  return verifySenderIdentity({
    context: params.context,
    mailboxId: params.mailboxId,
    senderIdentityId: identity.data.id,
    bindingId: parsed.data.bindingId,
    verificationRecipient: binding.email,
    savesSentAutomatically: parsed.data.savesSentAutomatically,
  });
};

export const verifySenderIdentity = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  senderIdentityId: string;
  bindingId: string;
  verificationRecipient: string;
  savesSentAutomatically: boolean;
  locale?: string;
}): Promise<Result<SenderIdentity>> => {
  const recipient = params.verificationRecipient.trim().toLowerCase();
  if (!/^.+@.+\..+$/.test(recipient) || recipient.length > 320) return fail(err.badInput("Invalid verification recipient"));
  const allowed = await requireMailboxPermission(params.context, params.mailboxId, "admin");
  if (!allowed.ok) return allowed;
  const record = await loadSenderVerification(params);
  if (!record) return fail(err.notFound("Sender identity or provider binding"));
  try {
    const barrier = await withMailboxProviderOperationBarrier(params.mailboxId, [record.remote_resource_id], async (assertLeaseActive) =>
      sql.begin(async (tx) => {
        const permission = await requireLockedMailboxAdmin(params.context, params.mailboxId, tx);
        if (!permission.ok) return permission;
        const current = await loadSenderVerification({ ...params, db: tx, lock: true });
        if (!current || current.remote_resource_id !== record.remote_resource_id) {
          return fail(err.badInput("Sender identity or provider binding changed before verification"));
        }
        if (!params.savesSentAutomatically) {
          if (!current.sent_folder_id) return fail(err.badInput("A Sent folder is required when the provider does not save sent mail"));
          const [sentRef] = await tx<{ allowed: boolean }[]>`
            SELECT 'insert' = ANY(effective_rights) AS allowed
            FROM mail.binding_folder_refs
            WHERE binding_id = ${params.bindingId}::uuid AND folder_id = ${current.sent_folder_id}::uuid
          `;
          if (!sentRef?.allowed) return fail(err.badInput("The selected binding cannot append to the configured Sent folder"));
        }

        const messageId = `<cloud-sender-verification-${crypto.randomUUID()}@${current.from_address.split("@")[1] ?? "mail.invalid"}>`;
        const snapshot = await loadProviderConnectionRuntimeSnapshot(current.connection_id);
        if (snapshot.secretRevision !== current.secret_revision) {
          return fail(err.conflict("Provider credentials changed before sender verification"));
        }
        try {
          const t = verificationMessages.resolve([params.locale ?? "en"]).t;
          await assertLeaseActive();
          const result = await imapSmtpConnector.send(snapshot.runtime, {
            from: { name: current.display_name, address: current.from_address },
            replyTo: current.reply_to,
            envelopeFrom: current.envelope_sender,
            to: [{ address: recipient }],
            subject: t.subject,
            text: t.body({ address: current.from_address }),
            messageId,
          });
          await assertLeaseActive();
          if (result.accepted.length === 0 || result.rejected.includes(recipient)) {
            await tx`
              UPDATE mail.sender_identities
              SET status = 'rejected', last_provider_rejection = 'Provider rejected sender identity verification'
              WHERE id = ${current.id}::uuid
            `;
            return fail(err.badInput("The provider did not accept the sender identity verification message"));
          }
        } catch (error) {
          if ((error as { code?: unknown } | null)?.code === "MAIL_PROVIDER_OPERATION_LEASE_LOST") throw error;
          await tx`
            UPDATE mail.sender_identities
            SET status = 'rejected', last_provider_rejection = 'Provider rejected sender identity verification'
            WHERE id = ${current.id}::uuid
          `;
          return fail(err.badInput("The provider rejected sender identity verification"));
        }

        await tx`
        INSERT INTO mail.sender_identity_bindings (
          sender_identity_id,
          binding_id,
          provider_principal,
          verified_at,
          verified_secret_revision,
          saves_sent_automatically,
          revoked_at,
          last_error_code
        )
        VALUES (
          ${current.id}::uuid,
          ${params.bindingId}::uuid,
          ${current.authenticated_principal ?? current.connection_username},
          now(),
          ${current.secret_revision},
          ${params.savesSentAutomatically},
          NULL,
          NULL
        )
        ON CONFLICT (sender_identity_id, binding_id) DO UPDATE SET
          provider_principal = EXCLUDED.provider_principal,
          verified_at = now(),
          verified_secret_revision = EXCLUDED.verified_secret_revision,
          saves_sent_automatically = EXCLUDED.saves_sent_automatically,
          revoked_at = NULL,
          last_error_code = NULL
        `;
        const [updated] = await tx<DbIdentity[]>`
        UPDATE mail.sender_identities si
        SET status = 'verified', last_provider_rejection = NULL
        WHERE si.id = ${current.id}::uuid
          AND si.mailbox_id = ${params.mailboxId}::uuid
          AND si.status <> 'disabled'
        RETURNING ${identityColumns}
        `;
        if (!updated)
          throw Object.assign(new Error("Sender identity disappeared during verification"), { code: "SENDER_IDENTITY_MISSING" });
        await audit.record(
          {
            action: "mail.sender_identity.verify",
            outcome: "allowed",
            actor: auditActorFromRequest(params.context),
            target: { type: "sender_identity", id: updated.id, label: updated.from_address },
            requestId: params.context.requestId,
            metadata: { bindingId: params.bindingId, savesSentAutomatically: params.savesSentAutomatically },
          },
          tx,
        );
        await assertLeaseActive();
        return ok(mapIdentity(updated));
      }),
    );
    return barrier.acquired ? barrier.value : fail(err.conflict("Provider work is still running; retry sender verification shortly"));
  } catch (error) {
    return (error as { code?: unknown } | null)?.code === "MAIL_PROVIDER_OPERATION_LEASE_LOST"
      ? fail(err.conflict("Provider state changed during sender verification; retry the operation"))
      : fail(err.internal("Failed to verify sender identity"));
  }
};
