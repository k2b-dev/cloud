import { err, fail, ok, type Result } from "@k2b/stdlib";
import { audit, isUniqueViolation, toPgTextArray, toPgUuidArray } from "@k2b/cloud/services";
import { sql } from "bun";
import type {
  CreateMailProtectedIdentityInput,
  CreateMailSecurityPolicyInput,
  MailProtectedIdentity,
  MailSecurityAssessment,
  MailSecurityPolicy,
  MailSecurityReport,
  MailSecuritySettings,
  UpdateMailSecurityPolicyInput,
} from "../security-contracts";
import { isCurrentPlatformAdmin, requireMailboxPermission } from "./access";
import { normalizeEmailAddress, normalizeEmailDomain } from "./address-normalization";
import { actorRefFromRequest, auditActorFromRequest, type MailRequestContext, userBackedActor } from "./auth";
import { assessMailSecurityEvidence } from "./security-evidence";

type DbPolicy = {
  id: string;
  disposition: MailSecurityPolicy["disposition"];
  target: MailSecurityPolicy["target"];
  value: string;
  note: string | null;
  enabled: boolean;
  created_at: Date | string;
  updated_at: Date | string;
};

type DbIdentity = {
  id: string;
  name: string;
  allowed_domains: string[];
  note: string | null;
  enabled: boolean;
  created_at: Date | string;
  updated_at: Date | string;
};

type DbReport = {
  id: string;
  mailbox_id: string;
  message_id: string;
  sender_address: string | null;
  sender_domain: string | null;
  status: MailSecurityReport["status"];
  report_count: number;
  assessment: MailSecurityAssessment | string;
  resolution_note: string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

const toIso = (value: Date | string): string => (value instanceof Date ? value : new Date(value)).toISOString();
const parseJson = <T>(value: T | string): T => (typeof value === "string" ? (JSON.parse(value) as T) : value);

const normalizePolicyValue = (target: MailSecurityPolicy["target"], value: string): string | null =>
  target === "sender_address" ? normalizeEmailAddress(value) : normalizeEmailDomain(value);

const normalizeIdentityName = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

const mapPolicy = (row: DbPolicy): MailSecurityPolicy => ({
  id: row.id,
  disposition: row.disposition,
  target: row.target,
  value: row.value,
  note: row.note,
  enabled: row.enabled,
  createdAt: toIso(row.created_at),
  updatedAt: toIso(row.updated_at),
});

const mapIdentity = (row: DbIdentity): MailProtectedIdentity => ({
  id: row.id,
  name: row.name,
  allowedDomains: row.allowed_domains,
  note: row.note,
  enabled: row.enabled,
  createdAt: toIso(row.created_at),
  updatedAt: toIso(row.updated_at),
});

const mapReport = (row: DbReport): MailSecurityReport => ({
  id: row.id,
  mailboxId: row.mailbox_id,
  messageId: row.message_id,
  senderAddress: row.sender_address,
  senderDomain: row.sender_domain,
  status: row.status,
  reportCount: Number(row.report_count),
  assessment: parseJson(row.assessment),
  resolutionNote: row.resolution_note,
  createdAt: toIso(row.created_at),
  updatedAt: toIso(row.updated_at),
});

const requirePlatformAdmin = async (context: MailRequestContext): Promise<Result<void>> =>
  (await isCurrentPlatformAdmin(context)) ? ok() : fail(err.forbidden("Cloud administration access is required"));

const loadConfiguration = async (): Promise<{
  policies: MailSecurityPolicy[];
  protectedIdentities: MailProtectedIdentity[];
  trustedAuthservIds: string[];
}> => {
  const [policies, identities, settings] = await Promise.all([
    sql<DbPolicy[]>`
      SELECT id, disposition, target, value, note, enabled, created_at, updated_at
      FROM mail.security_policies
      WHERE enabled
      ORDER BY disposition, target, value
    `,
    sql<DbIdentity[]>`
      SELECT id, name, allowed_domains, note, enabled, created_at, updated_at
      FROM mail.protected_identities
      WHERE enabled
      ORDER BY normalized_name
    `,
    sql<{ trusted_authserv_ids: string[] }[]>`
      SELECT trusted_authserv_ids FROM mail.security_settings WHERE singleton = true
    `,
  ]);
  return {
    policies: policies.map(mapPolicy),
    protectedIdentities: identities.map(mapIdentity),
    trustedAuthservIds: settings[0]?.trusted_authserv_ids ?? [],
  };
};

export const assessMessages = async (mailboxId: string, messageIds: string[]): Promise<Result<Map<string, MailSecurityAssessment>>> => {
  if (messageIds.length === 0) return ok(new Map());
  const [messages, configuration] = await Promise.all([
    sql<
      {
        id: string;
        selected_headers: Record<string, unknown> | string;
        sanitized_html: string | null;
        from_addresses: Array<{ name: string | null; address: string }> | string;
        reply_to_addresses: Array<{ name: string | null; address: string }> | string;
        outgoing: boolean;
      }[]
    >`
    SELECT
      message.id,
      message.selected_headers,
      message.sanitized_html,
      COALESCE(from_rows.addresses, '[]'::jsonb) AS from_addresses,
      COALESCE(reply_rows.addresses, '[]'::jsonb) AS reply_to_addresses,
      EXISTS (
        SELECT 1
        FROM mail.message_addresses sender
        JOIN mail.sender_identities identity
          ON identity.mailbox_id = message.mailbox_id
         AND lower(identity.from_address) = sender.normalized_email
         AND identity.status <> 'disabled'
        WHERE sender.message_id = message.id AND sender.role = 'from'
      ) AS outgoing
    FROM mail.message_contents message
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(jsonb_build_object('name', address.display_name, 'address', address.email) ORDER BY address.position) AS addresses
      FROM mail.message_addresses address
      WHERE address.message_id = message.id AND address.role = 'from'
    ) from_rows ON true
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(jsonb_build_object('name', address.display_name, 'address', address.email) ORDER BY address.position) AS addresses
      FROM mail.message_addresses address
      WHERE address.message_id = message.id AND address.role = 'reply_to'
    ) reply_rows ON true
    WHERE message.mailbox_id = ${mailboxId}::uuid
      AND message.id = ANY(${toPgUuidArray(messageIds)}::uuid[])
    `,
    loadConfiguration(),
  ]);
  const evaluatedAt = new Date().toISOString();
  const assessments = new Map<string, MailSecurityAssessment>();
  for (const message of messages) {
    const assessment: MailSecurityAssessment = message.outgoing
      ? { risk: "none", verdict: "clear", findings: [], linksDisabled: false, evaluatedAt }
      : assessMailSecurityEvidence({
          from: parseJson(message.from_addresses),
          replyTo: parseJson(message.reply_to_addresses),
          selectedHeaders: parseJson(message.selected_headers),
          sanitizedHtml: message.sanitized_html,
          ...configuration,
          evaluatedAt,
        });
    assessments.set(message.id, assessment);
  }
  return ok(assessments);
};

export const assessMessage = async (mailboxId: string, messageId: string): Promise<Result<MailSecurityAssessment>> => {
  const result = await assessMessages(mailboxId, [messageId]);
  if (!result.ok) return result;
  const assessment = result.data.get(messageId);
  return assessment ? ok(assessment) : fail(err.notFound("Mail message"));
};

export const getMessageAssessment = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  messageId: string;
}): Promise<Result<MailSecurityAssessment>> => {
  const access = await requireMailboxPermission(params.context, params.mailboxId, "read");
  return access.ok ? assessMessage(params.mailboxId, params.messageId) : access;
};

export const reportMessage = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  messageId: string;
}): Promise<Result<MailSecurityReport>> => {
  const access = await requireMailboxPermission(params.context, params.mailboxId, "read");
  if (!access.ok) return access;
  const actor = actorRefFromRequest(params.context);
  if (actor.kind !== "user" && actor.kind !== "service_account") return fail(err.forbidden("This actor cannot report mail"));
  const [message] = await sql<{ outgoing: boolean; sender_address: string | null }[]>`
    SELECT
      (
        SELECT sender.email
        FROM mail.message_addresses sender
        WHERE sender.message_id = content.id AND sender.role = 'from'
        ORDER BY sender.position
        LIMIT 1
      ) AS sender_address,
      EXISTS (
      SELECT 1
      FROM mail.message_addresses sender
      JOIN mail.sender_identities identity
        ON identity.mailbox_id = content.mailbox_id
       AND lower(identity.from_address) = sender.normalized_email
       AND identity.status <> 'disabled'
      WHERE sender.message_id = content.id AND sender.role = 'from'
      ) AS outgoing
    FROM mail.message_contents content
    WHERE content.mailbox_id = ${params.mailboxId}::uuid
      AND content.id = ${params.messageId}::uuid
  `;
  if (!message) return fail(err.notFound("Mail message"));
  if (message.outgoing) return fail(err.badInput("Outgoing messages cannot be reported as phishing"));
  const senderAddress = message.sender_address ? normalizeEmailAddress(message.sender_address) : null;
  const senderDomain = senderAddress ? normalizeEmailDomain(senderAddress.slice(senderAddress.lastIndexOf("@") + 1)) : null;
  const assessment = await assessMessage(params.mailboxId, params.messageId);
  if (!assessment.ok) return assessment;
  const result = await sql.begin(async (tx) => {
    const [report] = await tx<DbReport[]>`
      INSERT INTO mail.security_reports (mailbox_id, message_id, sender_address, sender_domain, assessment)
      VALUES (
        ${params.mailboxId}::uuid, ${params.messageId}::uuid, ${senderAddress}, ${senderDomain}, ${assessment.data}::jsonb
      )
      ON CONFLICT (mailbox_id, message_id) DO UPDATE SET
        sender_address = EXCLUDED.sender_address,
        sender_domain = EXCLUDED.sender_domain,
        assessment = EXCLUDED.assessment,
        status = CASE WHEN mail.security_reports.status = 'dismissed' THEN 'new' ELSE mail.security_reports.status END,
        resolution_note = CASE WHEN mail.security_reports.status = 'dismissed' THEN NULL ELSE mail.security_reports.resolution_note END,
        reviewed_by_user_id = CASE WHEN mail.security_reports.status = 'dismissed' THEN NULL ELSE mail.security_reports.reviewed_by_user_id END,
        updated_at = CASE WHEN mail.security_reports.status = 'dismissed' THEN now() ELSE mail.security_reports.updated_at END
      RETURNING id, mailbox_id, message_id, sender_address, sender_domain, status, report_count, assessment, resolution_note, created_at, updated_at
    `;
    if (!report) throw new Error("Mail security report insert returned no row");
    const actorId = actor.kind === "user" ? actor.userId : actor.serviceAccountId;
    const addedSources = await tx<{ report_id: string }[]>`
      INSERT INTO mail.security_report_sources (report_id, actor_kind, actor_id)
      VALUES (${report.id}::uuid, ${actor.kind}, ${actorId}::uuid)
      ON CONFLICT DO NOTHING
      RETURNING report_id
    `;
    const [updatedReport] = await tx<DbReport[]>`
      UPDATE mail.security_reports
      SET
        report_count = (
          SELECT count(*)::integer FROM mail.security_report_sources source WHERE source.report_id = ${report.id}::uuid
        ),
        updated_at = CASE WHEN ${addedSources.length > 0} THEN now() ELSE updated_at END
      WHERE id = ${report.id}::uuid
      RETURNING id, mailbox_id, message_id, sender_address, sender_domain, status, report_count, assessment, resolution_note, created_at, updated_at
    `;
    if (!updatedReport) throw new Error("Mail security report update returned no row");
    await audit.record(
      {
        action: "mail.security.report.create",
        outcome: "allowed",
        actor: auditActorFromRequest(params.context),
        target: { type: "mail_message", id: params.messageId },
        requestId: params.context.requestId,
        metadata: { mailboxId: params.mailboxId, reportId: report.id, verdict: assessment.data.verdict },
      },
      tx,
    );
    return mapReport(updatedReport);
  });
  return ok(result);
};

export const listReports = async (
  context: MailRequestContext,
  query: { status?: MailSecurityReport["status"]; limit: number },
): Promise<Result<MailSecurityReport[]>> => {
  const allowed = await requirePlatformAdmin(context);
  if (!allowed.ok) return allowed;
  const rows = await sql<DbReport[]>`
    SELECT id, mailbox_id, message_id, sender_address, sender_domain, status, report_count, assessment, resolution_note, created_at, updated_at
    FROM mail.security_reports
    WHERE (${query.status ?? null}::text IS NULL OR status = ${query.status ?? null})
    ORDER BY updated_at DESC, id DESC
    LIMIT ${query.limit}
  `;
  return ok(rows.map(mapReport));
};

export const resolveReport = async (params: {
  context: MailRequestContext;
  reportId: string;
  status: "in_review" | "confirmed" | "dismissed";
  resolutionNote?: string | null;
}): Promise<Result<MailSecurityReport>> => {
  const allowed = await requirePlatformAdmin(params.context);
  if (!allowed.ok) return allowed;
  const reviewer = userBackedActor(params.context)?.id ?? null;
  const row = await sql.begin(async (tx) => {
    const [updated] = await tx<DbReport[]>`
      UPDATE mail.security_reports
      SET status = ${params.status}, resolution_note = ${params.resolutionNote ?? null}, reviewed_by_user_id = ${reviewer}::uuid, updated_at = now()
      WHERE id = ${params.reportId}::uuid
      RETURNING id, mailbox_id, message_id, sender_address, sender_domain, status, report_count, assessment, resolution_note, created_at, updated_at
    `;
    if (!updated) return null;
    await audit.record(
      {
        action: "mail.security.report.resolve",
        outcome: "allowed",
        actor: auditActorFromRequest(params.context),
        target: { type: "mail_security_report", id: updated.id },
        requestId: params.context.requestId,
        metadata: { status: params.status },
      },
      tx,
    );
    return updated;
  });
  if (!row) return fail(err.notFound("Mail security report"));
  return ok(mapReport(row));
};

export const listPolicies = async (context: MailRequestContext): Promise<Result<MailSecurityPolicy[]>> => {
  const allowed = await requirePlatformAdmin(context);
  if (!allowed.ok) return allowed;
  const rows = await sql<DbPolicy[]>`
    SELECT id, disposition, target, value, note, enabled, created_at, updated_at
    FROM mail.security_policies ORDER BY disposition, target, value
  `;
  return ok(rows.map(mapPolicy));
};

export const createPolicy = async (params: {
  context: MailRequestContext;
  input: CreateMailSecurityPolicyInput;
}): Promise<Result<MailSecurityPolicy>> => {
  const allowed = await requirePlatformAdmin(params.context);
  if (!allowed.ok) return allowed;
  if (params.input.disposition === "trust" && params.input.target === "link_domain") {
    return fail(err.badInput("Trusted entries support sender addresses and sender domains only"));
  }
  const value = normalizePolicyValue(params.input.target, params.input.value);
  if (!value) return fail(err.badInput("Enter a valid email address or domain"));
  const creator = userBackedActor(params.context)?.id ?? null;
  try {
    const row = await sql.begin(async (tx) => {
      const [created] = await tx<DbPolicy[]>`
        INSERT INTO mail.security_policies (disposition, target, value, note, enabled, created_by_user_id)
        VALUES (${params.input.disposition}, ${params.input.target}, ${value}, ${params.input.note ?? null}, ${params.input.enabled}, ${creator}::uuid)
        ON CONFLICT (disposition, target, value) DO UPDATE SET
          note = COALESCE(EXCLUDED.note, mail.security_policies.note),
          enabled = EXCLUDED.enabled,
          updated_at = now()
        RETURNING id, disposition, target, value, note, enabled, created_at, updated_at
      `;
      if (!created) throw new Error("Mail security policy insert returned no row");
      await audit.record(
        {
          action: "mail.security.policy.create",
          outcome: "allowed",
          actor: auditActorFromRequest(params.context),
          target: { type: "mail_security_policy", id: created.id },
          requestId: params.context.requestId,
          metadata: { disposition: created.disposition, target: created.target, value: created.value },
        },
        tx,
      );
      return created;
    });
    return ok(mapPolicy(row));
  } catch {
    return fail(err.internal("Failed to create Mail security policy"));
  }
};

export const updatePolicy = async (params: {
  context: MailRequestContext;
  policyId: string;
  input: UpdateMailSecurityPolicyInput;
}): Promise<Result<MailSecurityPolicy>> => {
  const allowed = await requirePlatformAdmin(params.context);
  if (!allowed.ok) return allowed;
  const row = await sql.begin(async (tx) => {
    const [updated] = await tx<DbPolicy[]>`
      UPDATE mail.security_policies
      SET
        note = CASE WHEN ${params.input.note === undefined} THEN note ELSE ${params.input.note ?? null} END,
        enabled = COALESCE(${params.input.enabled ?? null}::boolean, enabled),
        updated_at = now()
      WHERE id = ${params.policyId}::uuid
      RETURNING id, disposition, target, value, note, enabled, created_at, updated_at
    `;
    if (!updated) return null;
    await audit.record(
      {
        action: "mail.security.policy.update",
        outcome: "allowed",
        actor: auditActorFromRequest(params.context),
        target: { type: "mail_security_policy", id: updated.id },
        requestId: params.context.requestId,
        metadata: { enabled: updated.enabled },
      },
      tx,
    );
    return updated;
  });
  return row ? ok(mapPolicy(row)) : fail(err.notFound("Mail security policy"));
};

export const deletePolicy = async (context: MailRequestContext, policyId: string): Promise<Result<{ deleted: true }>> => {
  const allowed = await requirePlatformAdmin(context);
  if (!allowed.ok) return allowed;
  const row = await sql.begin(async (tx) => {
    const [deleted] = await tx<{ id: string }[]>`DELETE FROM mail.security_policies WHERE id = ${policyId}::uuid RETURNING id`;
    if (!deleted) return null;
    await audit.record(
      {
        action: "mail.security.policy.delete",
        outcome: "allowed",
        actor: auditActorFromRequest(context),
        target: { type: "mail_security_policy", id: deleted.id },
        requestId: context.requestId,
      },
      tx,
    );
    return deleted;
  });
  return row ? ok({ deleted: true }) : fail(err.notFound("Mail security policy"));
};

export const listProtectedIdentities = async (context: MailRequestContext): Promise<Result<MailProtectedIdentity[]>> => {
  const allowed = await requirePlatformAdmin(context);
  if (!allowed.ok) return allowed;
  const rows = await sql<DbIdentity[]>`
    SELECT id, name, allowed_domains, note, enabled, created_at, updated_at
    FROM mail.protected_identities ORDER BY normalized_name
  `;
  return ok(rows.map(mapIdentity));
};

export const createProtectedIdentity = async (params: {
  context: MailRequestContext;
  input: CreateMailProtectedIdentityInput;
}): Promise<Result<MailProtectedIdentity>> => {
  const allowed = await requirePlatformAdmin(params.context);
  if (!allowed.ok) return allowed;
  const domains = [...new Set(params.input.allowedDomains.map(normalizeEmailDomain))];
  if (!domains.every((domain): domain is string => domain !== null)) return fail(err.badInput("Enter valid allowed domains"));
  const creator = userBackedActor(params.context)?.id ?? null;
  try {
    const row = await sql.begin(async (tx) => {
      const [created] = await tx<DbIdentity[]>`
        INSERT INTO mail.protected_identities (name, normalized_name, allowed_domains, note, enabled, created_by_user_id)
        VALUES (
          ${params.input.name}, ${normalizeIdentityName(params.input.name)}, ${toPgTextArray(domains)}::text[],
          ${params.input.note ?? null}, ${params.input.enabled}, ${creator}::uuid
        )
        RETURNING id, name, allowed_domains, note, enabled, created_at, updated_at
      `;
      if (!created) throw new Error("Protected identity insert returned no row");
      await audit.record(
        {
          action: "mail.security.protected_identity.create",
          outcome: "allowed",
          actor: auditActorFromRequest(params.context),
          target: { type: "mail_protected_identity", id: created.id, label: created.name },
          requestId: params.context.requestId,
          metadata: { allowedDomains: created.allowed_domains },
        },
        tx,
      );
      return created;
    });
    return ok(mapIdentity(row));
  } catch (error) {
    if (isUniqueViolation(error)) return fail(err.conflict("This protected identity already exists"));
    return fail(err.internal("Failed to create protected identity"));
  }
};

export const deleteProtectedIdentity = async (context: MailRequestContext, identityId: string): Promise<Result<{ deleted: true }>> => {
  const allowed = await requirePlatformAdmin(context);
  if (!allowed.ok) return allowed;
  const row = await sql.begin(async (tx) => {
    const [deleted] = await tx<{ id: string; name: string }[]>`
      DELETE FROM mail.protected_identities WHERE id = ${identityId}::uuid RETURNING id, name
    `;
    if (!deleted) return null;
    await audit.record(
      {
        action: "mail.security.protected_identity.delete",
        outcome: "allowed",
        actor: auditActorFromRequest(context),
        target: { type: "mail_protected_identity", id: deleted.id, label: deleted.name },
        requestId: context.requestId,
      },
      tx,
    );
    return deleted;
  });
  return row ? ok({ deleted: true }) : fail(err.notFound("Protected identity"));
};

export const getSettings = async (context: MailRequestContext): Promise<Result<MailSecuritySettings>> => {
  const allowed = await requirePlatformAdmin(context);
  if (!allowed.ok) return allowed;
  const [row] = await sql<{ trusted_authserv_ids: string[]; updated_at: Date | string }[]>`
    SELECT trusted_authserv_ids, updated_at FROM mail.security_settings WHERE singleton = true
  `;
  return row
    ? ok({ trustedAuthservIds: row.trusted_authserv_ids, updatedAt: toIso(row.updated_at) })
    : fail(err.internal("Mail security settings are unavailable"));
};

export const updateSettings = async (params: {
  context: MailRequestContext;
  trustedAuthservIds: string[];
}): Promise<Result<MailSecuritySettings>> => {
  const allowed = await requirePlatformAdmin(params.context);
  if (!allowed.ok) return allowed;
  const ids = [...new Set(params.trustedAuthservIds.map(normalizeEmailDomain))];
  if (!ids.every((value): value is string => value !== null)) {
    return fail(err.badInput("Enter valid authentication server names"));
  }
  const userId = userBackedActor(params.context)?.id ?? null;
  const row = await sql.begin(async (tx) => {
    const [updated] = await tx<{ trusted_authserv_ids: string[]; updated_at: Date | string }[]>`
      UPDATE mail.security_settings
      SET trusted_authserv_ids = ${toPgTextArray(ids)}::text[], updated_by_user_id = ${userId}::uuid, updated_at = now()
      WHERE singleton = true
      RETURNING trusted_authserv_ids, updated_at
    `;
    if (!updated) return null;
    await audit.record(
      {
        action: "mail.security.settings.update",
        outcome: "allowed",
        actor: auditActorFromRequest(params.context),
        target: { type: "mail_security_settings", id: "singleton" },
        requestId: params.context.requestId,
        metadata: { trustedAuthservIds: updated.trusted_authserv_ids },
      },
      tx,
    );
    return updated;
  });
  return row
    ? ok({ trustedAuthservIds: row.trusted_authserv_ids, updatedAt: toIso(row.updated_at) })
    : fail(err.internal("Mail security settings are unavailable"));
};
