import { err, fail, ok, type Result } from "@k2b/stdlib";
import { audit } from "@k2b/cloud/services";
import { sql } from "bun";
import { z } from "zod";
import {
  type ActorRef,
  archiveComposeTemplateInputSchema,
  type ComposePreview,
  type ComposePreviewInput,
  type ComposeSignatureDefault,
  type ComposeSuggestion,
  type ComposeSuggestionsInput,
  type ComposeTemplate,
  type CreateComposeTemplateInput,
  composeSuggestionsInputSchema,
  createComposeTemplateInputSchema,
  type DraftEditableContent,
  type DraftEditableContentInput,
  draftEditableContentInputSchema,
  type MailboxComposeStyle,
  type RenderComposeSnippetInput,
  renderComposeSnippetInputSchema,
  type SetComposeSignatureDefaultInput,
  setComposeSignatureDefaultInputSchema,
  type UpdateComposeTemplateInput,
  type UpdateMailboxComposeStyleInput,
  updateComposeTemplateInputSchema,
  updateMailboxComposeStyleInputSchema,
} from "../contracts";
import { withShortIdDb } from "../lib/short-id";
import { requireMailboxPermission } from "./access";
import { actorRefFromRequest, auditActorFromRequest, type MailRequestContext, userBackedActor } from "./auth";
import { sha256Text } from "./canonical";
import {
  type ComposeRenderContext,
  markComposeTemplateSegment,
  type RenderedComposeContent,
  renderComposeContent,
  renderComposeTemplateSource,
  validateComposeCss,
  validateComposeTemplateSource,
} from "./compose-renderer";

type SqlClient = typeof sql;

const internalDraftEditableContentSchema = draftEditableContentInputSchema.extend({ senderIdentityId: z.string().uuid() });
const internalSetComposeSignatureDefaultInputSchema = setComposeSignatureDefaultInputSchema.extend({
  templateId: z.string().uuid().nullable(),
});
const internalRenderComposeSnippetInputSchema = renderComposeSnippetInputSchema.extend({
  templateId: z.string().uuid(),
  draft: internalDraftEditableContentSchema,
  conversationId: z.string().uuid().nullable().default(null),
});
const internalComposeSuggestionsInputSchema = composeSuggestionsInputSchema.extend({
  draft: internalDraftEditableContentSchema,
  conversationId: z.string().uuid().nullable().default(null),
});

type DbTemplate = {
  id: string;
  short_id: string;
  mailbox_id: string;
  kind: ComposeTemplate["kind"];
  scope: ComposeTemplate["scope"];
  owner_user_id: string | null;
  name: string;
  shortcut: string;
  body_template: string;
  revision: string | number;
  archived_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

type DbDefault = {
  mailbox_id: string;
  sender_identity_id: string;
  user_id: string | null;
  template_id: string;
  revision: string | number;
  updated_at: Date | string;
};

type DbStyle = {
  mailbox_id: string;
  custom_css: string;
  revision: string | number;
  updated_at: Date | string;
};

const templateColumns = sql`
  template.id,
  template.short_id,
  template.mailbox_id,
  template.kind,
  template.scope,
  template.owner_user_id,
  template.name,
  template.shortcut,
  template.body_template,
  template.revision,
  template.archived_at,
  template.created_at,
  template.updated_at
`;

const toIso = (value: Date | string): string => (value instanceof Date ? value : new Date(value)).toISOString();
const mapTemplate = (row: DbTemplate, mailboxId: string): ComposeTemplate => ({
  id: row.id,
  mailboxId,
  kind: row.kind,
  scope: row.scope,
  ownerUserId: row.owner_user_id,
  name: row.name,
  shortcut: row.shortcut,
  body: row.body_template,
  revision: Number(row.revision),
  archivedAt: row.archived_at ? toIso(row.archived_at) : null,
  createdAt: toIso(row.created_at),
  updatedAt: toIso(row.updated_at),
});

const mapDefault = (row: DbDefault, ids: { mailboxId: string; senderIdentityId: string; templateId: string }): ComposeSignatureDefault => ({
  mailboxId: ids.mailboxId,
  senderIdentityId: ids.senderIdentityId,
  userId: row.user_id,
  templateId: ids.templateId,
  revision: Number(row.revision),
  updatedAt: toIso(row.updated_at),
});

const mapStyle = (row: DbStyle, mailboxId: string): MailboxComposeStyle => ({
  mailboxId,
  customCss: row.custom_css,
  revision: Number(row.revision),
  updatedAt: toIso(row.updated_at),
});

const actorDatabaseId = (actor: ActorRef): string | null => {
  if (actor.kind === "user") return actor.userId;
  if (actor.kind === "service_account") return actor.serviceAccountId;
  if (actor.kind === "workflow") return actor.workflowVersionId;
  return null;
};

const privateOwnerId = (context: MailRequestContext): string | null => userBackedActor(context)?.id ?? null;

const validateTemplateBody = (body: string): Result<void> => validateComposeTemplateSource(body);

const databaseCode = (error: unknown): string | null => {
  let current = error;
  for (let depth = 0; depth < 4 && current && typeof current === "object"; depth += 1) {
    const value = current as { code?: unknown; errno?: unknown; sqlState?: unknown; cause?: unknown };
    for (const candidate of [value.errno, value.sqlState, value.code]) {
      if (typeof candidate === "string" || typeof candidate === "number") {
        const code = String(candidate);
        if (/^\d{5}$/.test(code)) return code;
      }
    }
    current = value.cause;
  }
  return null;
};

const templateWriteAccess = (context: MailRequestContext, template: DbTemplate, permission: string): Result<void> => {
  if (template.scope === "mailbox") return permission === "admin" ? ok() : fail(err.forbidden("Mailbox templates require admin access"));
  return template.owner_user_id === privateOwnerId(context) ? ok() : fail(err.forbidden("Private template access denied"));
};

const readTemplateForUpdate = async (db: SqlClient, mailboxId: string, templateId: string): Promise<DbTemplate | null> => {
  const [template] = await db<DbTemplate[]>`
    SELECT ${templateColumns}
    FROM mail.compose_templates template
    WHERE template.id = ${templateId}::uuid AND template.mailbox_id = ${mailboxId}::uuid
    FOR UPDATE
  `;
  return template ?? null;
};

const writeAudit = async (
  context: MailRequestContext,
  action: string,
  mailboxId: string,
  templateId: string | null,
  metadata: Record<string, unknown>,
  db: SqlClient,
): Promise<void> => {
  await audit.record(
    {
      action,
      outcome: "allowed",
      actor: auditActorFromRequest(context),
      target: { type: templateId ? "mail_compose_template" : "mailbox", id: templateId ?? mailboxId },
      requestId: context.requestId,
      metadata: { mailboxId, ...metadata },
    },
    db,
  );
};

export const listComposeTemplates = async (context: MailRequestContext, mailboxId: string): Promise<Result<ComposeTemplate[]>> => {
  const allowed = await requireMailboxPermission(context, mailboxId, "write");
  if (!allowed.ok) return allowed;
  const ownerUserId = privateOwnerId(context);
  const rows = await sql<DbTemplate[]>`
    SELECT ${templateColumns}
    FROM mail.compose_templates template
    WHERE template.mailbox_id = ${mailboxId}::uuid
      AND template.archived_at IS NULL
      AND (template.scope = 'mailbox' OR template.owner_user_id = ${ownerUserId}::uuid)
    ORDER BY template.kind, template.scope, template.normalized_name, template.id
  `;
  return ok(rows.map((row) => mapTemplate(row, mailboxId)));
};

export const createComposeTemplate = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  input: CreateComposeTemplateInput;
}): Promise<Result<ComposeTemplate>> => {
  const parsed = createComposeTemplateInputSchema.safeParse(params.input);
  if (!parsed.success) return fail(err.badInput(parsed.error.issues[0]?.message ?? "Invalid compose template"));
  const body = validateTemplateBody(parsed.data.body);
  if (!body.ok) return body;
  const ownerUserId = privateOwnerId(params.context);
  if (parsed.data.scope === "private" && !ownerUserId) return fail(err.forbidden("Private templates require a user"));
  try {
    return await sql.begin(async (tx) => {
      const required = parsed.data.scope === "mailbox" ? "admin" : "write";
      const allowed = await requireMailboxPermission(params.context, params.mailboxId, required, tx);
      if (!allowed.ok) return allowed;
      const actor = actorRefFromRequest(params.context);
      const actorId = actorDatabaseId(actor);
      if (!actorId || actor.kind === "workflow" || actor.kind === "system") return fail(err.forbidden("Template author is invalid"));
      const [duplicate] = await tx<{ exists: boolean }[]>`
        SELECT true AS exists
        FROM mail.compose_templates
        WHERE mailbox_id = ${params.mailboxId}::uuid
          AND shortcut = ${parsed.data.shortcut}
          AND archived_at IS NULL
          AND (
            (${parsed.data.scope} = 'mailbox' AND scope = 'mailbox')
            OR (${parsed.data.scope} = 'private' AND scope = 'private' AND owner_user_id = ${ownerUserId}::uuid)
          )
        LIMIT 1
      `;
      if (duplicate) return fail(err.badInput("This shortcut is already used by another visible template"));
      const rows = await withShortIdDb(
        tx,
        "composeTemplate",
        (db, shortId) => db<DbTemplate[]>`
        INSERT INTO mail.compose_templates AS template (
          short_id, mailbox_id, kind, scope, owner_user_id, name, normalized_name, shortcut, body_template,
          created_by_actor_kind, created_by_actor_id
        ) VALUES (
          ${shortId},
          ${params.mailboxId}::uuid,
          ${parsed.data.kind},
          ${parsed.data.scope},
          ${parsed.data.scope === "private" ? ownerUserId : null}::uuid,
          ${parsed.data.name},
          ${parsed.data.name.toLocaleLowerCase()},
          ${parsed.data.shortcut},
          ${parsed.data.body},
          ${actor.kind},
          ${actorId}::uuid
        )
        RETURNING ${templateColumns}
      `,
      );
      const [row] = rows;
      if (!row) return fail(err.internal("Template insert returned no row"));
      await writeAudit(
        params.context,
        "mail.compose_template.create",
        params.mailboxId,
        row.short_id,
        {
          kind: row.kind,
          scope: row.scope,
        },
        tx,
      );
      return ok(mapTemplate(row, params.mailboxId));
    });
  } catch (error) {
    if (databaseCode(error) === "23505") {
      return fail(err.badInput("This shortcut is already used by another visible template"));
    }
    return fail(err.internal("Failed to create compose template"));
  }
};

export const updateComposeTemplate = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  templateId: string;
  input: UpdateComposeTemplateInput;
}): Promise<Result<ComposeTemplate>> => {
  const parsed = updateComposeTemplateInputSchema.safeParse(params.input);
  if (!parsed.success) return fail(err.badInput(parsed.error.issues[0]?.message ?? "Invalid compose template"));
  if (parsed.data.body !== undefined) {
    const body = validateTemplateBody(parsed.data.body);
    if (!body.ok) return body;
  }
  try {
    return await sql.begin(async (tx) => {
      const permission = await requireMailboxPermission(params.context, params.mailboxId, "write", tx);
      if (!permission.ok) return permission;
      const current = await readTemplateForUpdate(tx, params.mailboxId, params.templateId);
      if (!current || current.archived_at) return fail(err.notFound("Compose template"));
      const writable = templateWriteAccess(params.context, current, permission.data);
      if (!writable.ok) return writable;
      if (Number(current.revision) !== parsed.data.expectedRevision) return fail(err.conflict("Compose template"));
      if (parsed.data.shortcut && parsed.data.shortcut !== current.shortcut) {
        const [duplicate] = await tx<{ exists: boolean }[]>`
          SELECT true AS exists
          FROM mail.compose_templates
          WHERE mailbox_id = ${params.mailboxId}::uuid
            AND shortcut = ${parsed.data.shortcut}
            AND archived_at IS NULL
            AND id <> ${current.id}::uuid
            AND (
              (${current.scope} = 'mailbox' AND scope = 'mailbox')
              OR (${current.scope} = 'private' AND scope = 'private' AND owner_user_id = ${current.owner_user_id}::uuid)
            )
          LIMIT 1
        `;
        if (duplicate) return fail(err.badInput("This shortcut is already used by another visible template"));
      }
      const [row] = await tx<DbTemplate[]>`
        UPDATE mail.compose_templates template
        SET
          name = COALESCE(${parsed.data.name ?? null}, template.name),
          normalized_name = COALESCE(${parsed.data.name?.toLocaleLowerCase() ?? null}, template.normalized_name),
          shortcut = COALESCE(${parsed.data.shortcut ?? null}, template.shortcut),
          body_template = COALESCE(${parsed.data.body ?? null}, template.body_template),
          revision = template.revision + 1,
          updated_at = now()
        WHERE template.id = ${current.id}::uuid AND template.revision = ${parsed.data.expectedRevision}
        RETURNING ${templateColumns}
      `;
      if (!row) return fail(err.conflict("Compose template"));
      await writeAudit(
        params.context,
        "mail.compose_template.update",
        params.mailboxId,
        row.short_id,
        {
          changedFields: [
            ...(parsed.data.name !== undefined ? ["name"] : []),
            ...(parsed.data.shortcut !== undefined ? ["shortcut"] : []),
            ...(parsed.data.body !== undefined ? ["body"] : []),
          ],
          previousRevision: Number(current.revision),
          revision: Number(row.revision),
          previousBodyHash: sha256Text(current.body_template),
          bodyHash: sha256Text(row.body_template),
        },
        tx,
      );
      return ok(mapTemplate(row, params.mailboxId));
    });
  } catch (error) {
    if (databaseCode(error) === "23505") {
      return fail(err.badInput("This shortcut is already used by another visible template"));
    }
    return fail(err.internal("Failed to update compose template"));
  }
};

export const archiveComposeTemplate = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  templateId: string;
  input: unknown;
}): Promise<Result<void>> => {
  const parsed = archiveComposeTemplateInputSchema.safeParse(params.input);
  if (!parsed.success) return fail(err.badInput(parsed.error.issues[0]?.message ?? "Invalid compose template revision"));
  try {
    return await sql.begin(async (tx) => {
      const permission = await requireMailboxPermission(params.context, params.mailboxId, "write", tx);
      if (!permission.ok) return permission;
      const current = await readTemplateForUpdate(tx, params.mailboxId, params.templateId);
      if (!current || current.archived_at) return fail(err.notFound("Compose template"));
      const writable = templateWriteAccess(params.context, current, permission.data);
      if (!writable.ok) return writable;
      if (Number(current.revision) !== parsed.data.expectedRevision) return fail(err.conflict("Compose template"));
      const removedDefaults = await tx<{ template_id: string }[]>`
        DELETE FROM mail.compose_signature_defaults
        WHERE template_id = ${current.id}::uuid
        RETURNING template_id
      `;
      const [row] = await tx<{ id: string }[]>`
        UPDATE mail.compose_templates
        SET archived_at = now(), revision = revision + 1, updated_at = now()
        WHERE id = ${current.id}::uuid AND revision = ${parsed.data.expectedRevision}
        RETURNING id
      `;
      if (!row) return fail(err.conflict("Compose template"));
      await writeAudit(
        params.context,
        "mail.compose_template.archive",
        params.mailboxId,
        row.id,
        {
          kind: current.kind,
          scope: current.scope,
          previousRevision: Number(current.revision),
          removedDefaultCount: removedDefaults.length,
        },
        tx,
      );
      return ok();
    });
  } catch {
    return fail(err.internal("Failed to archive compose template"));
  }
};

export const listComposeSignatureDefaults = async (
  context: MailRequestContext,
  mailboxId: string,
): Promise<Result<ComposeSignatureDefault[]>> => {
  const allowed = await requireMailboxPermission(context, mailboxId, "write");
  if (!allowed.ok) return allowed;
  const ownerUserId = privateOwnerId(context);
  const rows = await sql<DbDefault[]>`
    SELECT defaults.mailbox_id, defaults.sender_identity_id, defaults.user_id, defaults.template_id,
      defaults.revision, defaults.updated_at
    FROM mail.compose_signature_defaults defaults
    JOIN mail.mailboxes mailbox ON mailbox.id = defaults.mailbox_id
    JOIN mail.sender_identities sender ON sender.id = defaults.sender_identity_id
    JOIN mail.compose_templates template ON template.id = defaults.template_id
    WHERE defaults.mailbox_id = ${mailboxId}::uuid
      AND (defaults.user_id IS NULL OR defaults.user_id = ${ownerUserId}::uuid)
    ORDER BY defaults.user_id NULLS LAST, defaults.sender_identity_id
  `;
  return ok(
    rows.map((row) =>
      mapDefault(row, {
        mailboxId: row.mailbox_id,
        senderIdentityId: row.sender_identity_id,
        templateId: row.template_id,
      }),
    ),
  );
};

export const setComposeSignatureDefault = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  senderIdentityId: string;
  input: SetComposeSignatureDefaultInput;
}): Promise<Result<ComposeSignatureDefault | null>> => {
  const parsed = internalSetComposeSignatureDefaultInputSchema.safeParse(params.input);
  if (!parsed.success) return fail(err.badInput(parsed.error.issues[0]?.message ?? "Invalid signature default"));
  const ownerUserId = privateOwnerId(params.context);
  if (parsed.data.scope === "private" && !ownerUserId) return fail(err.forbidden("Private defaults require a user"));
  try {
    return await sql.begin(async (tx) => {
      const required = parsed.data.scope === "mailbox" ? "admin" : "write";
      const permission = await requireMailboxPermission(params.context, params.mailboxId, required, tx);
      if (!permission.ok) return permission;
      const senderIdentityId = params.senderIdentityId;
      const [identity] = await tx<{ id: string }[]>`
        SELECT id FROM mail.sender_identities
        WHERE id = ${senderIdentityId}::uuid AND mailbox_id = ${params.mailboxId}::uuid AND status <> 'disabled'
        FOR UPDATE
      `;
      if (!identity) return fail(err.notFound("Sender identity"));
      const userId = parsed.data.scope === "private" ? ownerUserId : null;
      const [template] = parsed.data.templateId
        ? await tx<DbTemplate[]>`
          SELECT ${templateColumns}
          FROM mail.compose_templates template
          WHERE template.id = ${parsed.data.templateId}::uuid
            AND template.mailbox_id = ${params.mailboxId}::uuid
            AND template.kind = 'signature'
            AND template.archived_at IS NULL
            AND (
              (${parsed.data.scope} = 'mailbox' AND template.scope = 'mailbox')
              OR (
                ${parsed.data.scope} = 'private'
                AND (template.scope = 'mailbox' OR (template.scope = 'private' AND template.owner_user_id = ${ownerUserId}::uuid))
              )
            )
          FOR SHARE
        `
        : [];
      if (parsed.data.templateId && !template) return fail(err.badInput("The selected signature is not available for this default"));
      const [current] = await tx<DbDefault[]>`
        SELECT mailbox_id, sender_identity_id, user_id, template_id, revision, updated_at
        FROM mail.compose_signature_defaults
        WHERE mailbox_id = ${params.mailboxId}::uuid
          AND sender_identity_id = ${senderIdentityId}::uuid
          AND user_id IS NOT DISTINCT FROM ${userId}::uuid
        FOR UPDATE
      `;
      const currentRevision = current ? Number(current.revision) : null;
      if (currentRevision !== parsed.data.expectedRevision) return fail(err.conflict("Signature default"));
      if (!parsed.data.templateId) {
        if (current) {
          await tx`
            DELETE FROM mail.compose_signature_defaults
            WHERE mailbox_id = ${params.mailboxId}::uuid
              AND sender_identity_id = ${senderIdentityId}::uuid
              AND user_id IS NOT DISTINCT FROM ${userId}::uuid
          `;
        }
        await writeAudit(
          params.context,
          "mail.compose_signature_default.clear",
          params.mailboxId,
          null,
          {
            senderIdentityId: params.senderIdentityId,
            scope: parsed.data.scope,
            previousTemplateId: current?.template_id ?? null,
            previousRevision: currentRevision,
          },
          tx,
        );
        return ok(null);
      }
      if (!template) return fail(err.badInput("The selected signature is not available for this default"));
      const [row] =
        userId === null
          ? await tx<DbDefault[]>`
          INSERT INTO mail.compose_signature_defaults (
            mailbox_id, sender_identity_id, user_id, template_id, revision, updated_at
          ) VALUES (
            ${params.mailboxId}::uuid, ${senderIdentityId}::uuid, NULL, ${template.id}::uuid, 1, now()
          )
          ON CONFLICT (mailbox_id, sender_identity_id)
          WHERE user_id IS NULL
          DO UPDATE SET template_id = EXCLUDED.template_id, revision = mail.compose_signature_defaults.revision + 1, updated_at = now()
          RETURNING mailbox_id, sender_identity_id, user_id, template_id, revision, updated_at
        `
          : await tx<DbDefault[]>`
          INSERT INTO mail.compose_signature_defaults (
            mailbox_id, sender_identity_id, user_id, template_id, revision, updated_at
          ) VALUES (
            ${params.mailboxId}::uuid, ${senderIdentityId}::uuid, ${userId}::uuid, ${template.id}::uuid, 1, now()
          )
          ON CONFLICT (mailbox_id, sender_identity_id, user_id)
          WHERE user_id IS NOT NULL
          DO UPDATE SET template_id = EXCLUDED.template_id, revision = mail.compose_signature_defaults.revision + 1, updated_at = now()
          RETURNING mailbox_id, sender_identity_id, user_id, template_id, revision, updated_at
        `;
      if (!row) return fail(err.internal("Signature default update returned no row"));
      await writeAudit(
        params.context,
        "mail.compose_signature_default.set",
        params.mailboxId,
        template.short_id,
        {
          senderIdentityId: params.senderIdentityId,
          scope: parsed.data.scope,
          previousTemplateId: current?.template_id ?? null,
          previousRevision: currentRevision,
          revision: Number(row.revision),
        },
        tx,
      );
      return ok(
        mapDefault(row, {
          mailboxId: params.mailboxId,
          senderIdentityId: params.senderIdentityId,
          templateId: template.id,
        }),
      );
    });
  } catch {
    return fail(err.internal("Failed to update signature default"));
  }
};

export const getMailboxComposeStyle = async (
  context: MailRequestContext,
  mailboxId: string,
  db: SqlClient = sql,
): Promise<Result<MailboxComposeStyle>> => {
  const allowed = await requireMailboxPermission(context, mailboxId, "write", db);
  if (!allowed.ok) return allowed;
  const [row] = await db<DbStyle[]>`
    SELECT mailbox_id, custom_css, revision, updated_at
    FROM mail.compose_styles
    WHERE mailbox_id = ${mailboxId}::uuid
  `;
  if (!row) return fail(err.notFound("Mailbox email style"));
  return ok(mapStyle(row, mailboxId));
};

export const updateMailboxComposeStyle = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  input: UpdateMailboxComposeStyleInput;
}): Promise<Result<MailboxComposeStyle>> => {
  const parsed = updateMailboxComposeStyleInputSchema.safeParse(params.input);
  if (!parsed.success) return fail(err.badInput(parsed.error.issues[0]?.message ?? "Invalid email style"));
  const css = validateComposeCss(parsed.data.customCss);
  if (!css.ok) return css;
  try {
    return await sql.begin(async (tx) => {
      const allowed = await requireMailboxPermission(params.context, params.mailboxId, "admin", tx);
      if (!allowed.ok) return allowed;
      const actor = actorRefFromRequest(params.context);
      const actorId = actorDatabaseId(actor);
      if (!actorId || actor.kind === "workflow" || actor.kind === "system") return fail(err.forbidden("Style editor is invalid"));
      const [current] = await tx<DbStyle[]>`
        SELECT mailbox_id, custom_css, revision, updated_at
        FROM mail.compose_styles
        WHERE mailbox_id = ${params.mailboxId}::uuid
        FOR UPDATE
      `;
      if (!current) return fail(err.notFound("Mailbox email style"));
      if (Number(current.revision) !== parsed.data.expectedRevision) return fail(err.conflict("Mailbox email style"));
      const [row] = await tx<DbStyle[]>`
        UPDATE mail.compose_styles
        SET
          custom_css = ${css.data},
          revision = revision + 1,
          updated_by_actor_kind = ${actor.kind},
          updated_by_actor_id = ${actorId}::uuid,
          updated_at = now()
        WHERE mailbox_id = ${params.mailboxId}::uuid AND revision = ${parsed.data.expectedRevision}
        RETURNING mailbox_id, custom_css, revision, updated_at
      `;
      if (!row) return fail(err.conflict("Mailbox email style"));
      await writeAudit(
        params.context,
        "mail.compose_style.update",
        params.mailboxId,
        null,
        {
          previousRevision: Number(current.revision),
          revision: Number(row.revision),
          previousCssHash: sha256Text(current.custom_css),
          cssHash: sha256Text(row.custom_css),
        },
        tx,
      );
      return ok(mapStyle(row, params.mailboxId));
    });
  } catch {
    return fail(err.internal("Failed to update mailbox email style"));
  }
};

const composeRenderContext = async (params: {
  db: SqlClient;
  mailboxId: string;
  senderIdentityId: string;
  draft: DraftEditableContent;
  actor: ActorRef;
}): Promise<Result<ComposeRenderContext>> => {
  const [base] = await params.db<
    {
      mailbox_name: string;
      mailbox_description: string | null;
      sender_name: string;
      sender_email: string;
      sender_reply_to: string | null;
    }[]
  >`
    SELECT
      mailbox.name AS mailbox_name,
      mailbox.description AS mailbox_description,
      sender.display_name AS sender_name,
      sender.from_address AS sender_email,
      sender.reply_to AS sender_reply_to
    FROM mail.mailboxes mailbox
    JOIN mail.sender_identities sender ON sender.mailbox_id = mailbox.id
    WHERE mailbox.id = ${params.mailboxId}::uuid
      AND sender.id = ${params.senderIdentityId}::uuid
      AND mailbox.deleted_at IS NULL
      AND sender.status = 'verified'
  `;
  if (!base) return fail(err.badInput("A verified sender identity is required"));

  let actor = { display_name: "Mailbox automation", email: "" };
  const actorUserId =
    params.actor.kind === "user" ? params.actor.userId : params.actor.kind === "service_account" ? params.actor.delegatedUserId : null;
  if (actorUserId) {
    const [user] = await params.db<{ display_name: string; uid: string; mail: string | null }[]>`
      SELECT display_name, uid, mail FROM auth.users WHERE id = ${actorUserId}::uuid
    `;
    if (!user) return fail(err.badInput("The delegated compose user is no longer available"));
    actor = { display_name: user.display_name || user.uid, email: user.mail ?? "" };
  } else if (params.actor.kind === "service_account") {
    const [account] = await params.db<{ name: string }[]>`
      SELECT name FROM auth.service_accounts WHERE id = ${params.actor.serviceAccountId}::uuid
    `;
    if (account) actor = { display_name: account.name, email: "" };
  }

  return ok({
    actor,
    mailbox: { name: base.mailbox_name, description: base.mailbox_description ?? "" },
    sender: {
      display_name: base.sender_name || base.sender_email,
      email: base.sender_email,
      reply_to: base.sender_reply_to ?? "",
    },
    message: {
      subject: params.draft.subject,
      to: params.draft.to.map((entry) => entry.address),
      cc: params.draft.cc.map((entry) => entry.address),
    },
  });
};

const mailboxStyleSource = async (db: SqlClient, mailboxId: string): Promise<string> => {
  const [style] = await db<{ custom_css: string }[]>`
    SELECT custom_css FROM mail.compose_styles WHERE mailbox_id = ${mailboxId}::uuid
  `;
  return style?.custom_css ?? "";
};

export const renderComposeDraft = async (params: {
  db?: SqlClient;
  mailboxId: string;
  draft: DraftEditableContentInput;
  actor: ActorRef;
  renderLiquid: boolean;
}): Promise<Result<RenderedComposeContent>> => {
  const db = params.db ?? sql;
  const parsed = internalDraftEditableContentSchema.safeParse(params.draft);
  if (!parsed.success) return fail(err.badInput(parsed.error.issues[0]?.message ?? "Invalid draft"));
  const context = await composeRenderContext({
    db,
    mailboxId: params.mailboxId,
    senderIdentityId: parsed.data.senderIdentityId,
    draft: parsed.data,
    actor: params.actor,
  });
  if (!context.ok) return context;
  return renderComposeContent({
    body: parsed.data.body,
    format: parsed.data.format,
    customCss: await mailboxStyleSource(db, params.mailboxId),
    context: context.data,
    renderLiquid: params.renderLiquid,
  });
};

export const previewComposeDraft = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  input: ComposePreviewInput;
}): Promise<Result<ComposePreview>> => {
  const allowed = await requireMailboxPermission(params.context, params.mailboxId, "write");
  if (!allowed.ok) return allowed;
  const rendered = await renderComposeDraft({
    mailboxId: params.mailboxId,
    draft: params.input.draft,
    actor: actorRefFromRequest(params.context),
    renderLiquid: true,
  });
  if (!rendered.ok) return rendered;
  return ok({
    html: rendered.data.html ?? `<pre>${escapeHtml(rendered.data.text)}</pre>`,
    text: rendered.data.text,
  });
};

export const renderComposeSnippet = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  input: RenderComposeSnippetInput;
}): Promise<Result<{ markdown: string }>> => {
  const parsed = internalRenderComposeSnippetInputSchema.safeParse(params.input);
  if (!parsed.success) return fail(err.badInput(parsed.error.issues[0]?.message ?? "Invalid snippet request"));
  const allowed = await requireMailboxPermission(params.context, params.mailboxId, "write");
  if (!allowed.ok) return allowed;
  const ownerUserId = privateOwnerId(params.context);
  const [template] = await sql<DbTemplate[]>`
    SELECT ${templateColumns}
    FROM mail.compose_templates template
    WHERE template.id = ${parsed.data.templateId}::uuid
      AND template.mailbox_id = ${params.mailboxId}::uuid
      AND template.archived_at IS NULL
      AND (template.scope = 'mailbox' OR template.owner_user_id = ${ownerUserId}::uuid)
  `;
  if (!template) return fail(err.notFound("Compose template"));
  if (template.kind === "signature") return ok({ markdown: markComposeTemplateSegment(template.body_template) });
  const context = await composeRenderContext({
    db: sql,
    mailboxId: params.mailboxId,
    senderIdentityId: parsed.data.draft.senderIdentityId,
    draft: parsed.data.draft,
    actor: actorRefFromRequest(params.context),
  });
  if (!context.ok) return context;
  const rendered = renderComposeTemplateSource(template.body_template, context.data, parsed.data.draft.format);
  return rendered.ok ? ok({ markdown: rendered.data }) : rendered;
};

export const renderComposeSuggestions = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  input: ComposeSuggestionsInput;
}): Promise<Result<ComposeSuggestion[]>> => {
  const parsed = internalComposeSuggestionsInputSchema.safeParse(params.input);
  if (!parsed.success) return fail(err.badInput(parsed.error.issues[0]?.message ?? "Invalid compose suggestion request"));
  const allowed = await requireMailboxPermission(params.context, params.mailboxId, "write");
  if (!allowed.ok) return allowed;
  const ownerUserId = privateOwnerId(params.context);
  const query = parsed.data.query.toLocaleLowerCase();
  const rows = await sql<DbTemplate[]>`
    SELECT ${templateColumns}
    FROM (
      SELECT DISTINCT ON (source.shortcut) source.*
      FROM mail.compose_templates source
      WHERE source.mailbox_id = ${params.mailboxId}::uuid
        AND source.archived_at IS NULL
        AND (source.scope = 'mailbox' OR source.owner_user_id = ${ownerUserId}::uuid)
      ORDER BY
        source.shortcut,
        CASE WHEN source.scope = 'private' THEN 0 ELSE 1 END,
        source.id
    ) template
    WHERE (
        ${query} = ''
        OR position(${query} in template.shortcut) > 0
        OR position(${query} in template.normalized_name) > 0
      )
    ORDER BY
      CASE WHEN template.shortcut LIKE ${`${query}%`} THEN 0 ELSE 1 END,
      template.normalized_name,
      template.id
    LIMIT 12
  `;
  if (rows.length === 0) return ok([]);
  const context = await composeRenderContext({
    db: sql,
    mailboxId: params.mailboxId,
    senderIdentityId: parsed.data.draft.senderIdentityId,
    draft: parsed.data.draft,
    actor: actorRefFromRequest(params.context),
  });
  if (!context.ok) return context;
  const suggestions: ComposeSuggestion[] = [];
  for (const template of rows) {
    const rendered =
      template.kind === "signature"
        ? ok(markComposeTemplateSegment(template.body_template))
        : renderComposeTemplateSource(template.body_template, context.data, parsed.data.draft.format);
    if (!rendered.ok) return rendered;
    suggestions.push({
      templateId: template.id,
      name: template.name,
      shortcut: template.shortcut,
      kind: template.kind,
      markdown: rendered.data,
    });
  }
  return ok(suggestions);
};

export const resolveDefaultSignatureSource = async (params: {
  db: SqlClient;
  context: MailRequestContext;
  mailboxId: string;
  senderIdentityId: string;
}): Promise<string | null> => {
  const ownerUserId = privateOwnerId(params.context);
  const [template] = await params.db<{ body_template: string }[]>`
    SELECT template.body_template
    FROM mail.compose_signature_defaults default_signature
    JOIN mail.compose_templates template ON template.id = default_signature.template_id
    WHERE default_signature.mailbox_id = ${params.mailboxId}::uuid
      AND default_signature.sender_identity_id = (
        SELECT sender.id
        FROM mail.sender_identities sender
        WHERE sender.mailbox_id = ${params.mailboxId}::uuid AND sender.id = ${params.senderIdentityId}::uuid
      )
      AND template.kind = 'signature'
      AND template.archived_at IS NULL
      AND (default_signature.user_id = ${ownerUserId}::uuid OR default_signature.user_id IS NULL)
    ORDER BY (default_signature.user_id IS NOT NULL) DESC
    LIMIT 1
  `;
  return template ? markComposeTemplateSegment(template.body_template) : null;
};

const escapeHtml = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
