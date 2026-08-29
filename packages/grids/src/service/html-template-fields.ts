import { type DateContext, err, fail, ok, type Result } from "@k2b/stdlib";
import { logger } from "@valentinkolb/cloud/services";
import juice from "juice";
import {
  HTML_TEMPLATE_ERROR,
  HTML_TEMPLATE_RENDER_MAX_BYTES,
  HTML_TEMPLATE_TYPE,
  type HtmlTemplateConfig,
  htmlTemplateConfigSchema,
} from "../field-types/html-template";
import { datePatternContext, renderLiquidText, utf8ByteLength } from "./document-liquid";
import { documentServiceText, isGermanDocumentLocale } from "./document-messages";
import { projectPublicIds } from "./public-resources";
import { get as getTable } from "./tables";
import { buildTemplateAppData, buildTemplateBusinessData } from "./template-context";
import type { Field, GridRecord } from "./types";

const log = logger("grids:html-template-fields");
const MAX_HTML_ELEMENTS = 2_000;
const MAX_INLINE_WORK_BYTES = 8 * 1024 * 1024;
const MAX_BATCH_RENDER_CELLS = 2_000;
const MAX_BATCH_INLINE_WORK_BYTES = 32 * 1024 * 1024;
const MAX_BATCH_OUTPUT_BYTES = 32 * 1024 * 1024;

export type HtmlTemplateRenderBudget = {
  remainingCells: number;
  remainingInlineWorkBytes: number;
  remainingOutputBytes: number;
  exhausted: boolean;
  warningLogged: boolean;
};

export const createHtmlTemplateRenderBudget = (): HtmlTemplateRenderBudget => ({
  remainingCells: MAX_BATCH_RENDER_CELLS,
  remainingInlineWorkBytes: MAX_BATCH_INLINE_WORK_BYTES,
  remainingOutputBytes: MAX_BATCH_OUTPUT_BYTES,
  exhausted: false,
  warningLogged: false,
});

const relationIds = (value: unknown): string[] => {
  if (typeof value === "string") return [value];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
};

const publicRelationValue = (value: unknown, ids: ReadonlyMap<string, string>): unknown => {
  if (typeof value === "string") return ids.get(value) ?? null;
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      if (typeof item !== "string") return [];
      const publicId = ids.get(item);
      return publicId ? [publicId] : [];
    });
  }
  return null;
};

export const renderHtmlTemplateValue = async (
  config: HtmlTemplateConfig,
  context: Record<string, unknown>,
  budget?: HtmlTemplateRenderBudget,
  locale?: string,
): Promise<Result<string>> => {
  const t = documentServiceText(locale);
  if (!config.template) return ok("");
  try {
    const rendered = await renderLiquidText(config.template, context, HTML_TEMPLATE_RENDER_MAX_BYTES, locale);
    if (!rendered.ok) return rendered;
    const elementCount = rendered.data.match(/<[a-z][^>]*>/gi)?.length ?? 0;
    if (elementCount > MAX_HTML_ELEMENTS) return fail(err.badInput(t.htmlElementLimit({ limit: MAX_HTML_ELEMENTS })));
    const inlineWorkBytes = utf8ByteLength(rendered.data) + Math.max(elementCount, 1) * utf8ByteLength(config.css);
    if (inlineWorkBytes > MAX_INLINE_WORK_BYTES) {
      return fail(err.badInput(t.htmlTooComplex));
    }
    if (budget && inlineWorkBytes > budget.remainingInlineWorkBytes) {
      budget.exhausted = true;
      return fail(err.badInput(t.htmlBatchBudgetExceeded));
    }
    if (budget) budget.remainingInlineWorkBytes -= inlineWorkBytes;
    const html = config.css.trim()
      ? juice.inlineContent(rendered.data, config.css, {
          applyStyleTags: false,
          removeStyleTags: true,
          preserveMediaQueries: false,
          preserveFontFaces: false,
          preserveKeyFrames: false,
        })
      : rendered.data;
    const outputBytes = utf8ByteLength(html);
    if (outputBytes > HTML_TEMPLATE_RENDER_MAX_BYTES) return fail(err.badInput(t.renderedHtmlTooLarge));
    if (budget && outputBytes > budget.remainingOutputBytes) {
      budget.exhausted = true;
      return fail(err.badInput(t.htmlBatchOutputExceeded));
    }
    if (budget) budget.remainingOutputBytes -= outputBytes;
    return ok(html);
  } catch (error) {
    return fail(err.badInput(!isGermanDocumentLocale(locale) && error instanceof Error ? error.message : t.htmlRenderFailed));
  }
};

export const enrichRecordsWithHtmlTemplates = async (
  records: GridRecord[],
  fields: Field[],
  options: {
    dateConfig?: DateContext;
    now?: Date;
    fieldIds?: ReadonlySet<string>;
    budget?: HtmlTemplateRenderBudget;
    signal?: AbortSignal;
  } = {},
): Promise<GridRecord[]> => {
  const templateFields = fields.filter(
    (field) => !field.deletedAt && field.type === HTML_TEMPLATE_TYPE && (!options.fieldIds || options.fieldIds.has(field.id)),
  );
  if (templateFields.length === 0 || records.length === 0) return records;

  const setAll = (fieldsToSet: readonly Field[], value: string): void => {
    for (const record of records) for (const field of fieldsToSet) record.data[field.id] = value;
  };
  const validConfigs = new Map<string, HtmlTemplateConfig>();
  const renderFields: Field[] = [];
  for (const field of templateFields) {
    const parsed = htmlTemplateConfigSchema.safeParse(field.config);
    if (!parsed.success) {
      setAll([field], HTML_TEMPLATE_ERROR);
    } else if (!parsed.data.template) {
      setAll([field], "");
    } else {
      validConfigs.set(field.id, parsed.data);
      renderFields.push(field);
    }
  }
  if (renderFields.length === 0) return records;
  const budget = options.budget ?? createHtmlTemplateRenderBudget();
  if (budget.exhausted || budget.remainingCells === 0) {
    budget.exhausted = true;
    setAll(renderFields, HTML_TEMPLATE_ERROR);
    if (!budget.warningLogged) {
      budget.warningLogged = true;
      log.warn("HTML template batch render budget exceeded", { tableId: records[0]!.tableId });
    }
    return records;
  }
  if (options.signal?.aborted) throw options.signal.reason ?? new Error("HTML template rendering aborted");

  let table: NonNullable<Awaited<ReturnType<typeof getTable>>>;
  let app: Awaited<ReturnType<typeof buildTemplateAppData>>;
  let business: Awaited<ReturnType<typeof buildTemplateBusinessData>>;
  let publicRecordIds: ReadonlyMap<string, string>;
  try {
    const loadedTable = await getTable(records[0]!.tableId);
    if (!loadedTable || loadedTable.kind !== "stored") throw new Error("HTML template fields require a stored table");
    table = loadedTable;

    const relationFields = fields.filter((field) => !field.deletedAt && field.type === "relation");
    const relatedIds = records.flatMap((record) => relationFields.flatMap((field) => relationIds(record.data[field.id])));
    [app, publicRecordIds] = await Promise.all([buildTemplateAppData(), projectPublicIds("record", relatedIds)]);
    business = await buildTemplateBusinessData(table.baseId, app);
  } catch (error) {
    setAll(renderFields, HTML_TEMPLATE_ERROR);
    log.warn("HTML template field context preparation failed", {
      tableId: records[0]!.tableId,
      error: error instanceof Error ? error.message : String(error),
    });
    return records;
  }

  const generatedAt = options.now ?? new Date();
  const usableFields = fields.filter((field) => !field.deletedAt && field.type !== HTML_TEMPLATE_TYPE);
  let loggedRenderErrors = 0;

  for (const record of records) {
    const data = Object.fromEntries(
      usableFields.map((field) => [
        field.shortId,
        field.type === "relation" ? publicRelationValue(record.data[field.id] ?? null, publicRecordIds) : (record.data[field.id] ?? null),
      ]),
    );
    const context = {
      record: {
        id: record.shortId,
        tableId: table.shortId,
        version: record.version,
        data,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      },
      table: { id: table.shortId, name: table.name },
      app,
      business,
      date: datePatternContext(generatedAt, options.dateConfig),
    };

    for (const field of renderFields) {
      if (options.signal?.aborted) throw options.signal.reason ?? new Error("HTML template rendering aborted");
      if (budget.exhausted || budget.remainingCells === 0) {
        budget.exhausted = true;
        record.data[field.id] = HTML_TEMPLATE_ERROR;
        if (!budget.warningLogged) {
          budget.warningLogged = true;
          log.warn("HTML template batch render budget exceeded", { tableId: table.id });
        }
        continue;
      }
      budget.remainingCells -= 1;
      try {
        const rendered = await renderHtmlTemplateValue(validConfigs.get(field.id)!, context, budget, options.dateConfig?.locale);
        if (!rendered.ok) throw new Error(rendered.error.message);
        record.data[field.id] = rendered.data;
      } catch (error) {
        record.data[field.id] = HTML_TEMPLATE_ERROR;
        if (budget.exhausted) {
          if (!budget.warningLogged) {
            budget.warningLogged = true;
            log.warn("HTML template batch render budget exceeded", { tableId: table.id });
          }
        } else if (loggedRenderErrors < 10) {
          loggedRenderErrors += 1;
          log.warn("HTML template field render failed", {
            tableId: table.id,
            recordId: record.id,
            fieldId: field.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
  }
  return records;
};
