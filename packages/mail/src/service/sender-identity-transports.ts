import { err, fail, ok, type Result } from "@k2b/stdlib";
import { audit, decryptSecret, encryptSecret, logger } from "@k2b/cloud/services";
import { sql } from "bun";
import {
  type ProviderSecret,
  parseProviderLimitSnapshot,
  providerSecretSchema,
  type SenderIdentityTransport,
  type SmtpTransportCapabilities,
  smtpTransportCapabilitiesSchema,
  type UpdateSenderIdentityTransportInput,
  updateSenderIdentityTransportInputSchema,
} from "../contracts";
import { requireMailboxPermission } from "./access";
import { auditActorFromRequest, type MailRequestContext } from "./auth";
import { imapSmtpConnector } from "./connectors";
import type { SmtpConnectionConfig } from "./connectors/contract";
import { logDatabaseFailure } from "./database-errors";

const log = logger("mail:sender-identity-transports");

type DbTransport = {
  sender_identity_id: string;
  mailbox_id: string;
  host: string;
  port: number;
  tls_mode: "implicit" | "starttls";
  username: string;
  secret_kind: ProviderSecret["kind"];
  encrypted_secret: string | null;
  revision: number;
  status: "active" | "degraded" | "revoked";
  capabilities: SmtpTransportCapabilities | string;
  last_verified_at: Date | string | null;
  last_error_message: string | null;
};

const toIso = (value: Date | string | null): string | null =>
  value ? (value instanceof Date ? value : new Date(value)).toISOString() : null;

const parseCapabilities = (value: DbTransport["capabilities"]): SmtpTransportCapabilities =>
  smtpTransportCapabilitiesSchema.parse(typeof value === "string" ? JSON.parse(value) : value);

const mapTransport = (row: DbTransport): SenderIdentityTransport => ({
  mode: "custom",
  host: row.host,
  port: row.port,
  tlsMode: row.tls_mode,
  username: row.username,
  secret: { kind: row.secret_kind, isSet: Boolean(row.encrypted_secret) },
  revision: row.revision,
  status: row.status,
  capabilities: parseCapabilities(row.capabilities),
  lastVerifiedAt: toIso(row.last_verified_at),
  lastError: row.last_error_message,
});

const mailboxTransport = (limitSnapshot: unknown): SenderIdentityTransport => {
  const smtp = parseProviderLimitSnapshot(limitSnapshot).smtp;
  return {
    mode: "mailbox",
    host: null,
    port: null,
    tlsMode: null,
    username: null,
    secret: { kind: null, isSet: false },
    revision: 0,
    status: "active",
    capabilities: {
      dsn: smtp.dsn,
      size: smtp.status === "supported",
      maxMessageBytes: smtp.maxMessageBytes,
    },
    lastVerifiedAt: null,
    lastError: null,
  };
};

const safeTransportError = (error: unknown): string => {
  const code = String((error as { code?: unknown } | null)?.code ?? "").toUpperCase();
  if (code === "EAUTH" || code.includes("AUTH")) return "SMTP authentication failed";
  if (code.includes("CERT") || code.includes("TLS")) return "SMTP TLS verification failed";
  if (code.includes("ENDPOINT")) return "SMTP endpoint policy rejected the server";
  return "SMTP server could not be verified";
};

export const upsertSenderIdentityTransport = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  senderIdentityId: string;
  input: UpdateSenderIdentityTransportInput;
}): Promise<Result<SenderIdentityTransport>> => {
  const parsed = updateSenderIdentityTransportInputSchema.safeParse(params.input);
  if (!parsed.success) return fail(err.badInput(parsed.error.issues[0]?.message ?? "Invalid SMTP transport"));
  const access = await requireMailboxPermission(params.context, params.mailboxId, "admin");
  if (!access.ok) return access;
  const senderIdentityId = params.senderIdentityId;

  let current: DbTransport | undefined;
  try {
    [current] = await sql<DbTransport[]>`
      SELECT *
      FROM mail.sender_identity_transports
      WHERE sender_identity_id = ${senderIdentityId}::uuid
        AND mailbox_id = ${params.mailboxId}::uuid
    `;
  } catch (error) {
    logDatabaseFailure(log.error, "load", "sender identity transport", error);
    return fail(err.internal("Failed to load SMTP transport"));
  }
  if (!current && !parsed.data.secret) return fail(err.badInput("SMTP credentials are required when adding a custom transport"));
  if ((current?.revision ?? 0) !== parsed.data.expectedRevision) {
    return fail(err.conflict("SMTP transport changed before it could be saved"));
  }
  if (current && !parsed.data.secret && !current.encrypted_secret) {
    return fail(err.badInput("SMTP credentials are required because the stored credentials are unavailable"));
  }

  let secret: ProviderSecret;
  try {
    secret = parsed.data.secret
      ? parsed.data.secret
      : providerSecretSchema.parse(await decryptSecret<ProviderSecret>(current?.encrypted_secret ?? ""));
  } catch {
    return fail(err.internal("Could not load SMTP credentials"));
  }

  const runtime: SmtpConnectionConfig = {
    username: parsed.data.username,
    smtp: {
      host: parsed.data.host.toLowerCase(),
      port: parsed.data.port,
      tlsMode: parsed.data.tlsMode,
    },
    secret,
  };
  let capabilities: SmtpTransportCapabilities;
  try {
    capabilities = await imapSmtpConnector.verifySmtp(runtime);
  } catch (error) {
    return fail(err.badInput(safeTransportError(error)));
  }

  let encryptedSecret: string;
  try {
    encryptedSecret = parsed.data.secret ? await encryptSecret(parsed.data.secret) : (current?.encrypted_secret ?? "");
  } catch {
    return fail(err.internal("Could not encrypt SMTP credentials"));
  }

  try {
    return await sql.begin(async (tx) => {
      const recheck = await requireMailboxPermission(params.context, params.mailboxId, "admin", tx);
      if (!recheck.ok) return recheck;
      const [identity] = await tx<{ id: string }[]>`
        SELECT id
        FROM mail.sender_identities
        WHERE id = ${senderIdentityId}::uuid
          AND mailbox_id = ${params.mailboxId}::uuid
          AND status <> 'disabled'
        FOR UPDATE
      `;
      if (!identity) return fail(err.notFound("Sender identity"));
      const [locked] = await tx<{ revision: number; encrypted_secret: string | null }[]>`
        SELECT revision, encrypted_secret
        FROM mail.sender_identity_transports
        WHERE sender_identity_id = ${senderIdentityId}::uuid
          AND mailbox_id = ${params.mailboxId}::uuid
        FOR UPDATE
      `;
      if ((locked?.revision ?? 0) !== parsed.data.expectedRevision) {
        return fail(err.conflict("SMTP transport changed before it could be saved"));
      }
      if (!parsed.data.secret && locked?.encrypted_secret !== current?.encrypted_secret) {
        return fail(err.conflict("SMTP credentials changed before the server could be saved"));
      }
      const [stored] = await tx<DbTransport[]>`
        INSERT INTO mail.sender_identity_transports AS transport (
          sender_identity_id,
          mailbox_id,
          host,
          port,
          tls_mode,
          username,
          secret_kind,
          encrypted_secret,
          revision,
          status,
          capabilities,
          last_verified_at,
          last_error_message
        ) VALUES (
          ${senderIdentityId}::uuid,
          ${params.mailboxId}::uuid,
          ${runtime.smtp.host},
          ${runtime.smtp.port},
          ${runtime.smtp.tlsMode},
          ${runtime.username},
          ${secret.kind},
          ${encryptedSecret},
          1,
          'active',
          ${capabilities}::jsonb,
          now(),
          NULL
        )
        ON CONFLICT (sender_identity_id)
        DO UPDATE SET
          host = EXCLUDED.host,
          port = EXCLUDED.port,
          tls_mode = EXCLUDED.tls_mode,
          username = EXCLUDED.username,
          secret_kind = EXCLUDED.secret_kind,
          encrypted_secret = EXCLUDED.encrypted_secret,
          revision = transport.revision + 1,
          status = 'active',
          capabilities = EXCLUDED.capabilities,
          last_verified_at = now(),
          last_error_message = NULL,
          updated_at = now()
        RETURNING *
      `;
      if (!stored) return fail(err.internal("SMTP transport update returned no row"));
      await audit.record(
        {
          action: current ? "mail.sender_identity_transport.update" : "mail.sender_identity_transport.create",
          outcome: "allowed",
          actor: auditActorFromRequest(params.context),
          target: { type: "sender_identity", id: params.senderIdentityId },
          requestId: params.context.requestId,
          metadata: {
            mailboxId: params.mailboxId,
            host: stored.host,
            port: stored.port,
            tlsMode: stored.tls_mode,
            secretRotated: parsed.data.secret !== undefined,
            dsn: parseCapabilities(stored.capabilities).dsn,
          },
        },
        tx,
      );
      return ok(mapTransport(stored));
    });
  } catch (error) {
    logDatabaseFailure(log.error, "store", "sender identity transport", error);
    return fail(err.internal("Failed to store SMTP transport"));
  }
};

export const deleteSenderIdentityTransport = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  senderIdentityId: string;
  expectedRevision: number;
}): Promise<Result<SenderIdentityTransport>> => {
  const senderIdentityId = params.senderIdentityId;
  try {
    return await sql.begin(async (tx) => {
      const access = await requireMailboxPermission(params.context, params.mailboxId, "admin", tx);
      if (!access.ok) return access;
      const removed = await tx`
        DELETE FROM mail.sender_identity_transports
        WHERE sender_identity_id = ${senderIdentityId}::uuid
          AND mailbox_id = ${params.mailboxId}::uuid
          AND revision = ${params.expectedRevision}
        RETURNING sender_identity_id
      `;
      if (removed.length === 0) {
        const [exists] = await tx<{ revision: number }[]>`
          SELECT revision
          FROM mail.sender_identity_transports
          WHERE sender_identity_id = ${senderIdentityId}::uuid
            AND mailbox_id = ${params.mailboxId}::uuid
        `;
        return exists
          ? fail(err.conflict("SMTP transport changed before it could be removed"))
          : fail(err.notFound("Custom SMTP transport"));
      }
      const [connection] = await tx<{ limit_snapshot: unknown }[]>`
        SELECT limit_snapshot
        FROM mail.provider_connections
        WHERE owner_mailbox_id = ${params.mailboxId}::uuid
          AND status = 'active'
        LIMIT 1
      `;
      await audit.record(
        {
          action: "mail.sender_identity_transport.delete",
          outcome: "allowed",
          actor: auditActorFromRequest(params.context),
          target: { type: "sender_identity", id: params.senderIdentityId },
          requestId: params.context.requestId,
          metadata: { mailboxId: params.mailboxId },
        },
        tx,
      );
      return ok(mailboxTransport(connection?.limit_snapshot));
    });
  } catch (error) {
    logDatabaseFailure(log.error, "delete", "sender identity transport", error);
    return fail(err.internal("Failed to remove SMTP transport"));
  }
};

export const loadSenderIdentityTransportRuntimeById = async (params: {
  mailboxId: string;
  senderIdentityId: string;
  expectedRevision?: number;
}): Promise<{
  runtime: SmtpConnectionConfig;
  revision: number;
  capabilities: SmtpTransportCapabilities;
} | null> => {
  const [row] = await sql<DbTransport[]>`
    SELECT *
    FROM mail.sender_identity_transports
    WHERE sender_identity_id = ${params.senderIdentityId}::uuid
      AND mailbox_id = ${params.mailboxId}::uuid
      AND status = 'active'
      AND encrypted_secret IS NOT NULL
      AND (${params.expectedRevision ?? null}::int IS NULL OR revision = ${params.expectedRevision ?? null})
  `;
  if (!row?.encrypted_secret) return null;
  const secret = providerSecretSchema.parse(await decryptSecret<ProviderSecret>(row.encrypted_secret));
  return {
    runtime: {
      username: row.username,
      smtp: { host: row.host, port: row.port, tlsMode: row.tls_mode },
      secret,
    },
    revision: row.revision,
    capabilities: parseCapabilities(row.capabilities),
  };
};

export const loadSenderIdentityTransportRuntime = async (params: {
  mailboxId: string;
  senderIdentityId: string;
  expectedRevision?: number;
}): ReturnType<typeof loadSenderIdentityTransportRuntimeById> => {
  return loadSenderIdentityTransportRuntimeById(params);
};
