import { sql } from "@k2b/cloud";
import type { PermissionLevel } from "@k2b/cloud/contracts";
import { hasPermission } from "@k2b/cloud/server";
import { isUniqueViolation } from "@k2b/cloud/services";
import { err, fail, ok, type Result } from "@k2b/stdlib";
import {
  isBuiltInPageTemplateId,
  normalizePageTemplateName,
  PAGE_TEMPLATE_LIMIT,
  PAGE_TEMPLATE_MAX_LENGTH,
  type PageTemplatePlaceholders,
  type PageTemplateSummary,
  renderPageTemplate,
} from "../lib/page-templates";
import { generateUniqueShortId } from "../lib/short-id";
import { builtInPageTemplates, findBuiltInPageTemplate, localizedBuiltInPageTemplate } from "../templates/pages";
import { notebookServiceMessages } from "./messages";
import * as notes from "./notes";
import { invalidated, workspaceTransaction } from "./workspace-events";

// ==========================
// Page templates of one notebook. The notebook owns them: reading the notebook lists them, writing it makes pages from
// them and saves, renames and deletes them. Callers pass the permission their shared notebook check resolved; every
// rule below runs here, so the API, SSR, the CLI and capabilities enforce the same thing.
// ==========================

type DbPageTemplate = {
  id: string;
  short_id: string;
  notebook_id: string;
  name: string;
  content_md: string;
  updated_at: Date;
};

const NAME_INDEX = "idx_page_templates_notebook_name";

const messages = (locale?: string) => notebookServiceMessages.resolve(locale ? [locale] : []).t;

const summaryOf = (row: Pick<DbPageTemplate, "short_id" | "name" | "updated_at">): PageTemplateSummary => ({
  id: row.short_id,
  name: row.name,
  description: null,
  icon: "ti ti-template",
  builtIn: false,
  updatedAt: row.updated_at.toISOString(),
});

const builtInSummaries = (locale?: string): PageTemplateSummary[] =>
  builtInPageTemplates.map((template) => {
    const localized = localizedBuiltInPageTemplate(template, locale);
    return {
      id: template.id,
      name: localized.name,
      description: localized.description,
      icon: template.icon,
      builtIn: true,
      updatedAt: null,
    };
  });

const requirePermission = (permission: PermissionLevel, required: PermissionLevel, locale?: string): Result<void> =>
  hasPermission(permission, required) ? ok(undefined) : fail(err.forbidden(messages(locale).pageTemplateForbidden));

const notFound = (locale?: string) => fail({ code: "NOT_FOUND", message: messages(locale).pageTemplateNotFound, status: 404 });

/** The notebook's own templates by name, then the built-in ones. */
export const list = async (params: {
  notebookId: string;
  permission: PermissionLevel;
  locale?: string;
}): Promise<Result<PageTemplateSummary[]>> => {
  const allowed = requirePermission(params.permission, "read", params.locale);
  if (!allowed.ok) return allowed;
  const rows = await sql<DbPageTemplate[]>`
    SELECT short_id, name, updated_at
    FROM notebooks.page_templates
    WHERE notebook_id = ${params.notebookId}::uuid
    ORDER BY lower(name), short_id
    LIMIT ${PAGE_TEMPLATE_LIMIT}
  `;
  return ok([...rows.map(summaryOf), ...builtInSummaries(params.locale)]);
};

const findOwn = async (notebookId: string, templateId: string): Promise<DbPageTemplate | null> => {
  const [row] = await sql<DbPageTemplate[]>`
    SELECT id, short_id, notebook_id, name, content_md, updated_at
    FROM notebooks.page_templates
    WHERE notebook_id = ${notebookId}::uuid AND short_id = ${templateId}
  `;
  return row ?? null;
};

/**
 * The Markdown a new page starts from, with its placeholders filled in. Making a page needs write access; a template
 * of another notebook is not found here.
 */
export const draft = async (params: {
  notebookId: string;
  templateId: string;
  permission: PermissionLevel;
  placeholders: PageTemplatePlaceholders;
  locale?: string;
}): Promise<Result<{ name: string; contentMd: string }>> => {
  const allowed = requirePermission(params.permission, "write", params.locale);
  if (!allowed.ok) return allowed;
  const builtIn = isBuiltInPageTemplateId(params.templateId) ? findBuiltInPageTemplate(params.templateId) : null;
  if (builtIn) {
    const localized = localizedBuiltInPageTemplate(builtIn, params.locale);
    return ok({ name: localized.name, contentMd: renderPageTemplate(localized.content, params.placeholders) });
  }
  const own = isBuiltInPageTemplateId(params.templateId) ? null : await findOwn(params.notebookId, params.templateId);
  if (!own) return notFound(params.locale);
  return ok({ name: own.name, contentMd: renderPageTemplate(own.content_md, params.placeholders) });
};

/** A page's current text; the page must belong to the template's notebook, so its links and files keep working. */
const pageContent = async (notebookId: string, noteId: string, locale?: string): Promise<Result<string>> => {
  const t = messages(locale);
  const note = await notes.getCurrentWithContent({ id: noteId });
  if (!note || note.notebookId !== notebookId) return fail({ code: "NOT_FOUND", message: t.pageTemplateSourceNotFound, status: 404 });
  const content = note.contentMd ?? "";
  if (content.length > PAGE_TEMPLATE_MAX_LENGTH) return fail(err.badInput(t.pageTemplateTooLarge));
  return ok(content);
};

/** Saves a page of the notebook as a new template. Names are unique per notebook, ignoring case. */
export const create = async (params: {
  notebookId: string;
  permission: PermissionLevel;
  name: string;
  noteId: string;
  createdBy: string | null;
  locale?: string;
}): Promise<Result<PageTemplateSummary>> => {
  const t = messages(params.locale);
  const allowed = requirePermission(params.permission, "write", params.locale);
  if (!allowed.ok) return allowed;
  const name = normalizePageTemplateName(params.name);
  if (!name) return fail(err.badInput(t.pageTemplateNameInvalid));
  const content = await pageContent(params.notebookId, params.noteId, params.locale);
  if (!content.ok) return content;
  const shortId = await generateUniqueShortId("page_template");
  try {
    return await workspaceTransaction(async (tx): Promise<Result<PageTemplateSummary>> => {
      // One lock per notebook serializes saves, so parallel requests cannot pass the bound below.
      await tx`SELECT id FROM notebooks.notebooks WHERE id = ${params.notebookId}::uuid FOR UPDATE`;
      const [count] = await tx<{ count: number }[]>`
        SELECT COUNT(*)::int AS count FROM notebooks.page_templates WHERE notebook_id = ${params.notebookId}::uuid
      `;
      if ((count?.count ?? 0) >= PAGE_TEMPLATE_LIMIT) return fail(err.conflict(t.pageTemplateLimit({ count: PAGE_TEMPLATE_LIMIT })));
      const [row] = await tx<DbPageTemplate[]>`
        INSERT INTO notebooks.page_templates (short_id, notebook_id, name, content_md, created_by)
        VALUES (${shortId}, ${params.notebookId}::uuid, ${name}, ${content.data}, ${params.createdBy}::uuid)
        RETURNING short_id, name, updated_at
      `;
      if (!row) return fail(err.internal(t.pageTemplateSaveFailed));
      await invalidated({ notebookId: params.notebookId, reason: "template", scopes: ["templates"] }, tx);
      return ok(summaryOf(row));
    });
  } catch (error) {
    if (isUniqueViolation(error, NAME_INDEX)) return fail(err.conflict(t.pageTemplateNameTaken({ name })));
    throw error;
  }
};

/** Renames an own template, or replaces its content with a page's current text. Built-in templates stay as they are. */
export const update = async (params: {
  notebookId: string;
  templateId: string;
  permission: PermissionLevel;
  name?: string;
  noteId?: string;
  locale?: string;
}): Promise<Result<PageTemplateSummary>> => {
  const t = messages(params.locale);
  const allowed = requirePermission(params.permission, "write", params.locale);
  if (!allowed.ok) return allowed;
  if (isBuiltInPageTemplateId(params.templateId)) {
    return findBuiltInPageTemplate(params.templateId) ? fail(err.badInput(t.pageTemplateBuiltIn)) : notFound(params.locale);
  }
  const name = params.name === undefined ? undefined : normalizePageTemplateName(params.name);
  if (name === null) return fail(err.badInput(t.pageTemplateNameInvalid));
  const content = params.noteId === undefined ? undefined : await pageContent(params.notebookId, params.noteId, params.locale);
  if (content && !content.ok) return content;
  try {
    return await workspaceTransaction(async (tx): Promise<Result<PageTemplateSummary>> => {
      const [row] = await tx<DbPageTemplate[]>`
        UPDATE notebooks.page_templates SET
          name = COALESCE(${name ?? null}::text, name),
          content_md = COALESCE(${content?.data ?? null}::text, content_md),
          updated_at = now()
        WHERE notebook_id = ${params.notebookId}::uuid AND short_id = ${params.templateId}
        RETURNING short_id, name, updated_at
      `;
      if (!row) return notFound(params.locale);
      await invalidated({ notebookId: params.notebookId, reason: "template", scopes: ["templates"] }, tx);
      return ok(summaryOf(row));
    });
  } catch (error) {
    if (isUniqueViolation(error, NAME_INDEX)) return fail(err.conflict(t.pageTemplateNameTaken({ name: name ?? "" })));
    throw error;
  }
};

/** Deletes an own template; pages made from it stay as they are. */
export const remove = async (params: {
  notebookId: string;
  templateId: string;
  permission: PermissionLevel;
  locale?: string;
}): Promise<Result<void>> => {
  const allowed = requirePermission(params.permission, "write", params.locale);
  if (!allowed.ok) return allowed;
  if (isBuiltInPageTemplateId(params.templateId)) {
    return findBuiltInPageTemplate(params.templateId)
      ? fail(err.badInput(messages(params.locale).pageTemplateBuiltIn))
      : notFound(params.locale);
  }
  return workspaceTransaction(async (tx): Promise<Result<void>> => {
    const deleted = await tx`
      DELETE FROM notebooks.page_templates
      WHERE notebook_id = ${params.notebookId}::uuid AND short_id = ${params.templateId}
    `;
    if (deleted.count === 0) return notFound(params.locale);
    await invalidated({ notebookId: params.notebookId, reason: "template", scopes: ["templates"] }, tx);
    return ok(undefined);
  });
};
