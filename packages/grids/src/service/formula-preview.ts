import { type DateContext, ok, type Result } from "@k2b/stdlib";
import { sql } from "bun";
import { evaluate, renderResult } from "../formula/evaluator";
import { isFormulaError } from "../formula/functions";
import { collectFieldRefs, parseFormula } from "../formula/parser";
import { normalizeRefKey } from "../ref-syntax";
import { authoringText } from "./authoring-messages";
import { applyComputedProjections, buildComputedProjections, readableComputedTargetRecordAccess } from "./computed-projections";
import { listByTable as listFields } from "./fields";
import { parseJsonbRow } from "./jsonb";
import { type AuthorizedRecordAccess, recordAccessPredicate } from "./record-access";
import { type ExpansionViewer, enrichRecordsWithFormulas, hydrateRelationsFromLinks } from "./relations";
import type { Field, GridRecord } from "./types";

type DbRow = Record<string, unknown>;

type FormulaPreviewDiagnostic = {
  code: "formula.empty" | "formula.syntax" | "formula.unknown_field" | "formula.evaluation";
  severity: "error" | "info";
  message: string;
};

type FormulaPreviewField = {
  id: string;
  shortId: string;
  name: string;
  type: string;
};

type FormulaPreviewRow = {
  recordId: string;
  values: Record<string, unknown>;
  result: unknown;
};

type FormulaPreviewResult = {
  ok: boolean;
  diagnostics: FormulaPreviewDiagnostic[];
  fields: FormulaPreviewField[];
  rows: FormulaPreviewRow[];
};

const mapRow = (row: DbRow): GridRecord => ({
  id: row.id as string,
  shortId: row.short_id as string,
  tableId: row.table_id as string,
  data: parseJsonbRow<Record<string, unknown>>(row.data, {}),
  version: row.version as number,
  deletedAt: row.deleted_at ? (row.deleted_at as Date).toISOString() : null,
  createdBy: (row.created_by as string | null) ?? null,
  updatedBy: (row.updated_by as string | null) ?? null,
  createdAt: (row.created_at as Date).toISOString(),
  updatedAt: (row.updated_at as Date).toISOString(),
});

const resolveFormulaRefs = (refs: Set<string>, fields: Field[]) => {
  const byId = new Map(fields.map((field) => [field.id, field]));
  const byRef = new Map<string, Field[]>();
  for (const field of fields) {
    for (const ref of [field.shortId, field.name]) {
      const key = normalizeRefKey(ref);
      const bucket = byRef.get(key) ?? [];
      if (!bucket.some((item) => item.id === field.id)) bucket.push(field);
      byRef.set(key, bucket);
    }
  }
  const resolved: Field[] = [];
  const seen = new Set<string>();
  const missing: string[] = [];

  for (const ref of refs) {
    const matches = byRef.get(normalizeRefKey(ref)) ?? [];
    const field = byId.get(ref) ?? (matches.length === 1 ? matches[0] : null);
    if (!field) {
      missing.push(ref);
      continue;
    }
    if (seen.has(field.id)) continue;
    seen.add(field.id);
    resolved.push(field);
  }

  return { resolved, missing };
};

const loadLatestRows = async (
  tableId: string,
  fields: Field[],
  options: { recordAccess?: AuthorizedRecordAccess; viewer?: ExpansionViewer },
): Promise<GridRecord[]> => {
  const targetRecordAccess = await readableComputedTargetRecordAccess(fields, options.viewer);
  const computed = await buildComputedProjections(fields, { recordAccessByTableId: targetRecordAccess });
  const projectionFragments =
    computed.length > 0 ? computed.map((p) => sql`, ${p.fragment}`).reduce((acc, cur) => sql`${acc}${cur}`) : sql``;

  const rows = await sql<DbRow[]>`
    SELECT r.*${projectionFragments}
    FROM grids.records r
    JOIN grids.tables t ON t.id = r.table_id AND t.deleted_at IS NULL
    JOIN grids.bases b ON b.id = t.base_id AND b.deleted_at IS NULL
    WHERE r.table_id = ${tableId}::uuid
      AND r.deleted_at IS NULL
      AND ${recordAccessPredicate(options.recordAccess, "r")}
    ORDER BY r.created_at DESC, r.id DESC
    LIMIT 5
  `;

  const items = rows.map(mapRow);
  await hydrateRelationsFromLinks(items, fields, options.viewer);
  const recordsById = new Map(items.map((record) => [record.id, record]));
  applyComputedProjections(rows, recordsById, computed);
  return items;
};

export const checkFormula = async (params: {
  tableId: string;
  expression: string;
  currentFieldId?: string | null;
  dateConfig?: DateContext;
  recordAccess?: AuthorizedRecordAccess;
  viewer?: ExpansionViewer;
}): Promise<Result<FormulaPreviewResult>> => {
  const t = authoringText(params.dateConfig?.locale);
  const expression = params.expression.trim();
  if (!expression) {
    return ok({
      ok: true,
      diagnostics: [{ code: "formula.empty", severity: "info", message: t.formulaPreviewHint }],
      fields: [],
      rows: [],
    });
  }

  const parsed = parseFormula(expression);
  if (!parsed.ok) {
    return ok({
      ok: false,
      diagnostics: [{ code: "formula.syntax", severity: "error", message: t.formulaSyntax({ detail: parsed.error }) }],
      fields: [],
      rows: [],
    });
  }

  const fields = await listFields(params.tableId);
  const usableFields = fields.filter((field) => !field.deletedAt);
  const refs = collectFieldRefs(parsed.ast);
  const { resolved, missing } = resolveFormulaRefs(refs, usableFields);
  if (missing.length > 0) {
    return ok({
      ok: false,
      diagnostics: missing.map((ref) => ({
        code: "formula.unknown_field" as const,
        severity: "error" as const,
        message: t.formulaUnknownField({ field: ref }),
      })),
      fields: [],
      rows: [],
    });
  }

  const rows = await loadLatestRows(params.tableId, usableFields, {
    recordAccess: params.recordAccess,
    viewer: params.viewer,
  });
  const formulaFields = params.currentFieldId ? usableFields.filter((field) => field.id !== params.currentFieldId) : usableFields;
  enrichRecordsWithFormulas(rows, formulaFields, { dateConfig: params.dateConfig });

  const slugToId = Object.fromEntries(
    usableFields.flatMap((field) => [
      [field.shortId, field.id],
      [normalizeRefKey(field.shortId), field.id],
      [field.name, field.id],
      [normalizeRefKey(field.name), field.id],
    ]),
  );
  let hasPreviewError = false;
  const previewRows = rows.map((record) => {
    const rawResult = evaluate(parsed.ast, { fields: record.data, slugToId, dateConfig: params.dateConfig });
    if (isFormulaError(rawResult)) hasPreviewError = true;
    return {
      recordId: record.id,
      values: Object.fromEntries(resolved.map((field) => [field.id, record.data[field.id] ?? null])),
      result: renderResult(rawResult),
    };
  });

  return ok({
    ok: !hasPreviewError,
    diagnostics: hasPreviewError ? [{ code: "formula.evaluation", severity: "error", message: t.formulaEvaluation }] : [],
    fields: resolved.map((field) => ({
      id: field.id,
      shortId: field.shortId,
      name: field.name,
      type: field.type,
    })),
    rows: previewRows,
  });
};
