import { err, fail, ok, type Result } from "@k2b/stdlib";
import { isUniqueViolation } from "@valentinkolb/cloud/services";
import { sql } from "bun";
import type {
  CreateEmailTemplateInput,
  EmailTemplate,
  EmailTemplateDependency,
  EmailTemplateDependencyMap,
  UpdateEmailTemplateInput,
} from "../contracts";
import { logAudit, type SqlClient } from "./audit";
import { renderLiquidPlainText, renderLiquidText, validateLiquidRoots, validateLiquidTemplate } from "./documents";
import { parseJsonbRow } from "./jsonb";
import { serviceMessagesFor } from "./messages";
import { insertWithShortId } from "./short-id";
import { lockWorkflowCatalogMutation } from "./workflow-catalog-mutation";

type DbRow = Record<string, unknown>;

const EMAIL_TEMPLATE_ROOTS = new Set(["data", "app", "business", "workflow", "run", "date"]);

const mapEmailTemplate = (row: DbRow): EmailTemplate => ({
  id: row.id as string,
  shortId: row.short_id as string,
  baseId: row.base_id as string,
  name: row.name as string,
  description: (row.description as string | null) ?? null,
  subject: row.subject as string,
  html: row.html as string,
  sampleData: parseJsonbRow<EmailTemplate["sampleData"]>(row.sample_data, {}),
  enabled: row.enabled as boolean,
  position: row.position as number,
  createdBy: (row.created_by as string | null) ?? null,
  updatedBy: (row.updated_by as string | null) ?? null,
  deletedAt: row.deleted_at ? (row.deleted_at as Date).toISOString() : null,
  createdAt: (row.created_at as Date).toISOString(),
  updatedAt: (row.updated_at as Date).toISOString(),
});

const validateEmailLiquid = (source: string, label: string, locale?: string): Result<void> => {
  const syntax = validateLiquidTemplate(source, locale);
  if (!syntax.ok) return syntax;
  return validateLiquidRoots(source, EMAIL_TEMPLATE_ROOTS, label, locale);
};

export const validateEmailTemplateWrite = (input: { subject?: string | null; html?: string | null }, locale?: string): Result<void> => {
  const t = serviceMessagesFor(locale);
  if (input.subject !== undefined && input.subject !== null) {
    const valid = validateEmailLiquid(input.subject, t.emailSubjectLabel, locale);
    if (!valid.ok) return valid;
  }
  if (input.html !== undefined && input.html !== null) {
    const valid = validateEmailLiquid(input.html, t.emailHtmlLabel, locale);
    if (!valid.ok) return valid;
  }
  return ok();
};

export const renderEmailTemplate = async (
  template: Pick<EmailTemplate, "subject" | "html">,
  data: Record<string, unknown>,
  locale?: string,
): Promise<Result<{ subject: string; html: string }>> => {
  const subject = await renderLiquidPlainText(template.subject, data, 1_000, locale);
  if (!subject.ok) return subject;
  const html = await renderLiquidText(template.html, data, 300_000, locale);
  if (!html.ok) return html;
  return ok({ subject: subject.data.trim(), html: html.data });
};

export const listForBase = async (baseId: string): Promise<EmailTemplate[]> => {
  const rows = await sql<DbRow[]>`
    SELECT *
    FROM grids.email_templates
    WHERE base_id = ${baseId}::uuid AND deleted_at IS NULL
    ORDER BY position, created_at, id
  `;
  return rows.map(mapEmailTemplate);
};

export const listDependenciesForBase = async (baseId: string, client: SqlClient = sql): Promise<EmailTemplateDependencyMap> => {
  const rows = await client<
    Array<{
      template_id: string;
      workflow_id: string;
      workflow_short_id: string;
      workflow_name: string;
    }>
  >`
    SELECT DISTINCT
      binding.value AS template_id,
      workflow.id::text AS workflow_id,
      workflow.short_id AS workflow_short_id,
      definition.name AS workflow_name
    FROM grids.workflow_profile workflow
    JOIN workflows.workflow AS definition ON definition.id = workflow.id
    CROSS JOIN LATERAL (
      SELECT plan FROM workflows.version WHERE workflow_id = workflow.id ORDER BY revision DESC LIMIT 1
    ) AS version
    CROSS JOIN LATERAL jsonb_each_text(COALESCE(version.plan -> 'bindings', '{}'::jsonb)) binding
    JOIN grids.email_templates template
      ON template.id::text = binding.value
     AND template.base_id = workflow.base_id
     AND template.deleted_at IS NULL
    WHERE workflow.base_id = ${baseId}::uuid
      AND workflow.deleted_at IS NULL
      AND binding.key LIKE '%.sendEmail.template'
    ORDER BY workflow_name, workflow_id
  `;
  const dependencies: EmailTemplateDependencyMap = {};
  for (const row of rows) {
    const dependency: EmailTemplateDependency = {
      workflowId: row.workflow_id,
      workflowShortId: row.workflow_short_id,
      workflowName: row.workflow_name,
    };
    const templateDependencies = dependencies[row.template_id] ?? [];
    templateDependencies.push(dependency);
    dependencies[row.template_id] = templateDependencies;
  }
  return dependencies;
};

export const get = async (templateId: string, opts: { includeDeleted?: boolean } = {}): Promise<EmailTemplate | null> => {
  const [row] = opts.includeDeleted
    ? await sql<DbRow[]>`
        SELECT *
        FROM grids.email_templates
        WHERE id = ${templateId}::uuid
      `
    : await sql<DbRow[]>`
        SELECT *
        FROM grids.email_templates
        WHERE id = ${templateId}::uuid AND deleted_at IS NULL
      `;
  return row ? mapEmailTemplate(row) : null;
};

export const getByShortIdForBase = async (baseId: string, shortId: string): Promise<EmailTemplate | null> => {
  const [row] = await sql<DbRow[]>`
    SELECT *
    FROM grids.email_templates
    WHERE base_id = ${baseId}::uuid AND short_id = ${shortId} AND deleted_at IS NULL
  `;
  return row ? mapEmailTemplate(row) : null;
};

export const getByShortId = async (shortId: string): Promise<EmailTemplate | null> => {
  const [row] = await sql<DbRow[]>`
    SELECT template.*
    FROM grids.email_templates template
    JOIN grids.bases base ON base.id = template.base_id AND base.deleted_at IS NULL
    WHERE template.short_id = ${shortId} AND template.deleted_at IS NULL
  `;
  return row ? mapEmailTemplate(row) : null;
};

export const create = async (
  baseId: string,
  input: CreateEmailTemplateInput,
  actorId: string | null,
  locale?: string,
): Promise<Result<EmailTemplate>> => {
  const valid = validateEmailTemplateWrite(input, locale);
  if (!valid.ok) return valid;
  try {
    const created = await sql.begin(async (tx): Promise<EmailTemplate> => {
      const row = await insertWithShortId(async (shortId) => {
        const [inserted] = await tx<DbRow[]>`
          INSERT INTO grids.email_templates (
            short_id, base_id, name, description, subject, html, sample_data, enabled, position, created_by, updated_by
          )
          VALUES (
            ${shortId},
            ${baseId}::uuid,
            ${input.name.trim()},
            ${input.description?.trim() || null},
            ${input.subject.trim()},
            ${input.html},
            ${input.sampleData ?? {}}::jsonb,
            ${input.enabled ?? true},
            ${input.position ?? 0},
            ${actorId}::uuid,
            ${actorId}::uuid
          )
          RETURNING *
        `;
        if (!inserted) throw err.internal(serviceMessagesFor(locale).emailInsertFailed);
        return inserted;
      }, "idx_grids_email_templates_short_id");
      const mapped = mapEmailTemplate(row);
      await logAudit(
        {
          baseId,
          userId: actorId,
          action: "email_template.created",
          diff: { emailTemplate: { old: null, new: { id: mapped.id, name: mapped.name, enabled: mapped.enabled } } },
        },
        tx,
      );
      return mapped;
    });
    return ok(created);
  } catch (error) {
    if (isUniqueViolation(error, "idx_grids_email_templates_short_id"))
      return fail(err.conflict(serviceMessagesFor(locale).emailTemplateIdConflict));
    throw error;
  }
};

export const update = async (
  templateId: string,
  input: UpdateEmailTemplateInput,
  actorId: string | null,
  locale?: string,
): Promise<Result<EmailTemplate>> => {
  const existing = await get(templateId);
  if (!existing) return fail(err.notFound(serviceMessagesFor(locale).emailTemplate));
  const valid = validateEmailTemplateWrite(input, locale);
  if (!valid.ok) return valid;
  const [row] = await sql<DbRow[]>`
    UPDATE grids.email_templates
    SET name = ${input.name === undefined ? existing.name : input.name.trim()},
        description = ${input.description === undefined ? existing.description : input.description?.trim() || null},
        subject = ${input.subject === undefined ? existing.subject : input.subject.trim()},
        html = ${input.html === undefined ? existing.html : input.html},
        sample_data = ${input.sampleData ?? existing.sampleData}::jsonb,
        enabled = ${input.enabled ?? existing.enabled},
        position = ${input.position ?? existing.position},
        updated_by = ${actorId}::uuid,
        updated_at = now()
    WHERE id = ${templateId}::uuid AND deleted_at IS NULL
    RETURNING *
  `;
  if (!row) return fail(err.notFound(serviceMessagesFor(locale).emailTemplate));
  const updated = mapEmailTemplate(row);
  await logAudit({
    baseId: updated.baseId,
    userId: actorId,
    action: "email_template.updated",
    diff: {
      emailTemplate: {
        old: { id: existing.id, name: existing.name, enabled: existing.enabled },
        new: { id: updated.id, name: updated.name, enabled: updated.enabled },
      },
    },
  });
  return ok(updated);
};

export const remove = async (templateId: string, actorId: string | null, locale?: string): Promise<Result<void>> => {
  const existing = await get(templateId);
  if (!existing) return fail(err.notFound(serviceMessagesFor(locale).emailTemplate));
  return sql.begin(async (tx) => {
    await lockWorkflowCatalogMutation(existing.baseId, tx);
    const dependencies = (await listDependenciesForBase(existing.baseId, tx))[templateId] ?? [];
    if (dependencies.length > 0) {
      return fail({
        code: "CONFLICT",
        status: 409,
        message: serviceMessagesFor(locale).emailTemplateDependency({
          count: dependencies.length,
          workflow: dependencies[0]?.workflowName,
        }),
      });
    }
    const updated = await tx`
      UPDATE grids.email_templates
      SET deleted_at = now(), enabled = FALSE, updated_by = ${actorId}::uuid, updated_at = now()
      WHERE id = ${templateId}::uuid AND deleted_at IS NULL
    `;
    if (updated.count === 0) return fail(err.notFound(serviceMessagesFor(locale).emailTemplate));
    await logAudit(
      {
        baseId: existing.baseId,
        userId: actorId,
        action: "email_template.deleted",
        diff: { emailTemplate: { old: { id: existing.id, name: existing.name }, new: null } },
      },
      tx,
    );
    return ok();
  });
};
