import { err, fail, ok, type Result } from "@k2b/stdlib";
import { toPgUuidArray } from "@valentinkolb/cloud/services";
import { sql } from "bun";
import {
  type CreateDocumentTemplateInput,
  type DocumentTemplate,
  DocumentTemplateRendererSchema,
  type UpdateDocumentTemplateInput,
} from "../contracts";
import { documentProfiles, profileKey, profileRegistry } from "../document-profiles";
import { logAudit } from "./audit";
import { DOCUMENT_NUMBER_ROOTS, DOCUMENT_SOURCE_ROOTS, utf8ByteLength, validateDocumentLiquidTemplate } from "./document-liquid";
import { type DocumentDbRow, mapDocumentTemplate } from "./document-mappers";
import { documentServiceText } from "./document-messages";
import { provisionDocumentNumberSeries, setNumberSeriesArchived, syncNumberSeriesFormat } from "./number-series";
import { insertWithShortId } from "./short-id";
import { get as getTable } from "./tables";

const SOURCE_MAX_BYTES = 20_000;
const FILENAME_TEMPLATE_MAX_BYTES = 5_000;
const TEMPLATE_PART_MAX_BYTES = 50_000;
const profiles = profileRegistry(documentProfiles);

export const listTemplatesForTable = async (tableId: string): Promise<DocumentTemplate[]> => {
  const rows = await sql<DocumentDbRow[]>`
    SELECT dt.*
    FROM grids.document_templates dt
    JOIN grids.tables t ON t.id = dt.table_id AND t.deleted_at IS NULL
    JOIN grids.bases b ON b.id = t.base_id AND b.deleted_at IS NULL
    WHERE dt.table_id = ${tableId}::uuid AND dt.deleted_at IS NULL
    ORDER BY dt.position, dt.created_at
  `;
  return rows.map(mapDocumentTemplate);
};

export const getTemplate = async (templateId: string): Promise<DocumentTemplate | null> => {
  const [row] = await sql<DocumentDbRow[]>`
    SELECT dt.*
    FROM grids.document_templates dt
    JOIN grids.tables t ON t.id = dt.table_id AND t.deleted_at IS NULL
    JOIN grids.bases b ON b.id = t.base_id AND b.deleted_at IS NULL
    WHERE dt.id = ${templateId}::uuid AND dt.deleted_at IS NULL
  `;
  return row ? mapDocumentTemplate(row) : null;
};

export const getStoredTemplate = async (templateId: string): Promise<DocumentTemplate | null> => {
  const [row] = await sql<DocumentDbRow[]>`
    SELECT dt.*
    FROM grids.document_templates dt
    JOIN grids.tables t ON t.id = dt.table_id AND t.deleted_at IS NULL
    JOIN grids.bases b ON b.id = t.base_id AND b.deleted_at IS NULL
    WHERE dt.id = ${templateId}::uuid
  `;
  return row ? mapDocumentTemplate(row) : null;
};

export const getTemplateByShortIdForTable = async (tableId: string, shortId: string): Promise<DocumentTemplate | null> => {
  const [row] = await sql<DocumentDbRow[]>`
    SELECT dt.*
    FROM grids.document_templates dt
    JOIN grids.tables t ON t.id = dt.table_id AND t.deleted_at IS NULL
    JOIN grids.bases b ON b.id = t.base_id AND b.deleted_at IS NULL
    WHERE dt.table_id = ${tableId}::uuid
      AND dt.short_id = ${shortId}
      AND dt.deleted_at IS NULL
  `;
  return row ? mapDocumentTemplate(row) : null;
};

export const getTemplateByShortId = async (shortId: string): Promise<DocumentTemplate | null> => {
  const [row] = await sql<DocumentDbRow[]>`
    SELECT dt.*
    FROM grids.document_templates dt
    JOIN grids.tables t ON t.id = dt.table_id AND t.deleted_at IS NULL
    JOIN grids.bases b ON b.id = t.base_id AND b.deleted_at IS NULL
    WHERE dt.short_id = ${shortId} AND dt.deleted_at IS NULL
  `;
  return row ? mapDocumentTemplate(row) : null;
};

export const validateTemplateWrite = (
  input: { source?: string; renderer?: DocumentTemplate["renderer"] },
  locale?: string,
): Result<void> => {
  const t = documentServiceText(locale);
  if (input.source !== undefined) {
    if (!input.source.trim()) return fail(err.badInput(t.sourceRequired));
    if (utf8ByteLength(input.source) > SOURCE_MAX_BYTES) return fail(err.badInput(t.sourceTooLarge));
  }
  const parsedRenderer = input.renderer === undefined ? null : DocumentTemplateRendererSchema.safeParse(input.renderer);
  if (parsedRenderer && !parsedRenderer.success) return fail(err.badInput(t.invalidRenderer));
  const renderer = parsedRenderer?.data;
  if (renderer?.kind === "profile") {
    if (!profiles.has(profileKey(renderer.id, renderer.version))) {
      return fail(err.badInput(t.unknownProfile({ profile: `${renderer.id}@${renderer.version}` })));
    }
    const valid = validateDocumentLiquidTemplate(renderer.inputTemplate, t.profileInputLabel, undefined, locale);
    if (!valid.ok) return valid;
  }
  if (renderer?.kind === "html") {
    const body = validateDocumentLiquidTemplate(renderer.body, t.htmlTemplateLabel, undefined, locale);
    if (!body.ok) return body;
    for (const [label, value] of [
      [t.headerHtmlLabel, renderer.header],
      [t.footerHtmlLabel, renderer.footer],
      [t.pageCssLabel, renderer.css],
    ] as const) {
      if (!value) continue;
      if (utf8ByteLength(value) > TEMPLATE_PART_MAX_BYTES) return fail(err.badInput(t.partTooLarge({ part: label })));
      const valid = validateDocumentLiquidTemplate(value, label, undefined, locale);
      if (!valid.ok) return valid;
    }
    if (utf8ByteLength(renderer.numberTemplate) > FILENAME_TEMPLATE_MAX_BYTES) return fail(err.badInput(t.numberPatternTooLarge));
    const number = validateDocumentLiquidTemplate(renderer.numberTemplate, t.documentNumberPatternLabel, DOCUMENT_NUMBER_ROOTS, locale);
    if (!number.ok) return number;
    if (utf8ByteLength(renderer.filenameTemplate) > FILENAME_TEMPLATE_MAX_BYTES) return fail(err.badInput(t.filenameTemplateTooLarge));
    const filename = validateDocumentLiquidTemplate(renderer.filenameTemplate, t.filenameTemplateLabel, undefined, locale);
    if (!filename.ok) return filename;
  }
  if (input.source !== undefined) {
    const valid = validateDocumentLiquidTemplate(input.source, t.gqlSourceLabel, DOCUMENT_SOURCE_ROOTS, locale);
    if (!valid.ok) return valid;
  }
  return ok();
};

export const createTemplate = async (
  tableId: string,
  input: CreateDocumentTemplateInput,
  actorId: string | null,
  locale?: string,
): Promise<Result<DocumentTemplate>> => {
  const t = documentServiceText(locale);
  const table = await getTable(tableId);
  if (!table) return fail(err.notFound(t.tableNotFound));
  const valid = validateTemplateWrite(input, locale);
  if (!valid.ok) return valid;

  const name = input.name.trim();
  if (!name) return fail(err.badInput(t.nameRequired));
  const source = input.source.trim();
  const renderer = DocumentTemplateRendererSchema.parse(input.renderer);
  const html = renderer.kind === "html" ? renderer : null;
  const profile = renderer.kind === "profile" ? renderer : null;

  const row = await insertWithShortId<DocumentDbRow>(
    async (shortId) =>
      sql.begin(async (tx) => {
        const [created] = await tx<DocumentDbRow[]>`
          INSERT INTO grids.document_templates (
            short_id, table_id, name, description, source, renderer_kind,
            html, header_html, footer_html, page_css, number_template, filename_template,
            profile_id, profile_version, profile_input_template,
            enabled, position, created_by, updated_by
          )
          VALUES (
            ${shortId},
            ${tableId}::uuid,
            ${name},
            ${input.description ?? null},
            ${source},
            ${renderer.kind},
            ${html?.body ?? null},
            ${html?.header ?? null},
            ${html?.footer ?? null},
            ${html?.css ?? null},
            ${html?.numberTemplate ?? null},
            ${html?.filenameTemplate ?? null},
            ${profile?.id ?? null},
            ${profile?.version ?? null},
            ${profile?.inputTemplate ?? null},
            ${input.enabled ?? true},
            COALESCE((SELECT MAX(position) + 1 FROM grids.document_templates WHERE table_id = ${tableId}::uuid), 0),
            ${actorId}::uuid,
            ${actorId}::uuid
          )
          RETURNING *
        `;
        if (!created) throw new Error("insert returned no row");
        if (html) await provisionDocumentNumberSeries(tx, created.id as string, html.numberTemplate);
        await logAudit(
          {
            baseId: table.baseId,
            tableId,
            userId: actorId,
            action: "document_template.created",
            diff: { documentTemplate: { old: null, new: { id: created.id, name, enabled: input.enabled ?? true } } },
          },
          tx,
        );
        return created;
      }),
    "idx_grids_document_templates_short_id",
  );
  return ok(mapDocumentTemplate(row));
};

export const updateTemplate = async (
  templateId: string,
  input: UpdateDocumentTemplateInput,
  actorId: string | null,
  locale?: string,
): Promise<Result<DocumentTemplate>> => {
  const t = documentServiceText(locale);
  const existing = await getTemplate(templateId);
  if (!existing) return fail(err.notFound(t.documentTemplateNotFound));
  const candidate = { ...existing, ...input };
  const valid = validateTemplateWrite(candidate, locale);
  if (!valid.ok) return valid;
  const renderer = input.renderer === undefined ? undefined : DocumentTemplateRendererSchema.parse(input.renderer);
  const html = renderer?.kind === "html" ? renderer : null;
  const profile = renderer?.kind === "profile" ? renderer : null;

  const [row] = await sql.begin(async (tx) => {
    const rows = await tx<DocumentDbRow[]>`
      UPDATE grids.document_templates
      SET
        name = COALESCE(${input.name?.trim() || null}, name),
        description = ${input.description === undefined ? sql`description` : input.description},
        source = COALESCE(${input.source?.trim() || null}, source),
        renderer_kind = ${renderer?.kind ?? sql`renderer_kind`},
        html = ${renderer === undefined ? sql`html` : (html?.body ?? null)},
        header_html = ${renderer === undefined ? sql`header_html` : (html?.header ?? null)},
        footer_html = ${renderer === undefined ? sql`footer_html` : (html?.footer ?? null)},
        page_css = ${renderer === undefined ? sql`page_css` : (html?.css ?? null)},
        number_template = ${renderer === undefined ? sql`number_template` : (html?.numberTemplate ?? null)},
        filename_template = ${renderer === undefined ? sql`filename_template` : (html?.filenameTemplate ?? null)},
        profile_id = ${renderer === undefined ? sql`profile_id` : (profile?.id ?? null)},
        profile_version = ${renderer === undefined ? sql`profile_version` : (profile?.version ?? null)},
        profile_input_template = ${renderer === undefined ? sql`profile_input_template` : (profile?.inputTemplate ?? null)},
        enabled = COALESCE(${input.enabled ?? null}, enabled),
        position = COALESCE(${input.position ?? null}, position),
        updated_by = ${actorId}::uuid,
        updated_at = now()
      WHERE id = ${templateId}::uuid AND deleted_at IS NULL
      RETURNING *
    `;
    const updated = rows[0];
    if (updated) {
      await syncNumberSeriesFormat(
        tx,
        { kind: "document_template", id: templateId },
        updated.renderer_kind === "html"
          ? {
              strategy: "document",
              numberTemplate: updated.number_template as string,
            }
          : null,
      );
    }
    return rows;
  });
  return row ? ok(mapDocumentTemplate(row)) : fail(err.notFound(t.documentTemplateNotFound));
};

export const reorderTemplates = async (
  tableId: string,
  templateIds: string[],
  actorId: string | null,
  locale?: string,
): Promise<Result<void>> => {
  const t = documentServiceText(locale);
  const table = await getTable(tableId);
  if (!table) return fail(err.notFound(t.tableNotFound));
  if (new Set(templateIds).size !== templateIds.length) return fail(err.badInput(t.templateIdsUnique));

  return sql.begin(async (tx) => {
    const existing = await tx<{ id: string }[]>`
      SELECT id::text AS id
      FROM grids.document_templates
      WHERE table_id = ${tableId}::uuid AND deleted_at IS NULL
      FOR UPDATE
    `;
    const requested = new Set(templateIds);
    if (existing.length !== templateIds.length || existing.some((template) => !requested.has(template.id))) {
      return fail(err.conflict(t.templatesChanged));
    }

    const positions = `{${templateIds.map((_, index) => index).join(",")}}`;
    await tx`
      UPDATE grids.document_templates AS template
      SET position = ordered.position, updated_by = ${actorId}::uuid, updated_at = now()
      FROM unnest(${toPgUuidArray(templateIds)}::uuid[], ${positions}::int[]) AS ordered(id, position)
      WHERE template.id = ordered.id AND template.table_id = ${tableId}::uuid AND template.deleted_at IS NULL
    `;
    await logAudit(
      {
        baseId: table.baseId,
        tableId,
        userId: actorId,
        action: "updated",
        diff: { documentTemplateOrder: { old: null, new: templateIds } },
      },
      tx,
    );
    return ok();
  });
};

export const removeTemplate = async (templateId: string, actorId: string | null, locale?: string): Promise<Result<void>> => {
  const t = documentServiceText(locale);
  const [row] = await sql.begin(async (tx) => {
    const rows = await tx<DocumentDbRow[]>`
      UPDATE grids.document_templates
      SET deleted_at = now(), updated_by = ${actorId}::uuid, updated_at = now()
      WHERE id = ${templateId}::uuid AND deleted_at IS NULL
      RETURNING id
    `;
    if (rows[0]) await setNumberSeriesArchived(tx, { kind: "document_template", id: templateId }, true);
    return rows;
  });
  return row ? ok() : fail(err.notFound(t.documentTemplateNotFound));
};

export const restoreTemplate = async (templateId: string, actorId: string | null, locale?: string): Promise<Result<DocumentTemplate>> => {
  const t = documentServiceText(locale);
  const existing = await getStoredTemplate(templateId);
  if (!existing) return fail(err.notFound(t.documentTemplateNotFound));
  if (existing.deletedAt === null) return ok(existing);
  const [row] = await sql.begin(async (tx) => {
    const rows = await tx<DocumentDbRow[]>`
      UPDATE grids.document_templates
      SET deleted_at = NULL, updated_by = ${actorId}::uuid, updated_at = now()
      WHERE id = ${templateId}::uuid AND deleted_at IS NOT NULL
      RETURNING *
    `;
    if (rows[0] && existing.renderer.kind === "html") {
      await setNumberSeriesArchived(tx, { kind: "document_template", id: templateId }, false);
    }
    return rows;
  });
  return row ? ok(mapDocumentTemplate(row)) : fail(err.notFound(t.documentTemplateNotFound));
};
