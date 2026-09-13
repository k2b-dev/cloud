import { sql } from "bun";
import { parseFormula } from "../formula/parser";
import type { Expr } from "../formula/types";
import { formulaSqlFail, formulaSqlOk } from "./formula-sql-values";

export const DOCUMENT_QUERY_FUNCTIONS = new Set(["DOCUMENTCOUNT", "LATESTDOCUMENTAT"]);

/** Inspect resolved plans, including nested saved Views. */
export const containsDocumentMetadata = (value: unknown): boolean => {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(containsDocumentMetadata);
  const entries = Object.entries(value);
  if (entries.some(([key, item]) => key === "fn" && typeof item === "string" && DOCUMENT_QUERY_FUNCTIONS.has(item))) return true;
  return entries.some(([key, item]) => {
    if (key === "expression" && typeof item === "string") {
      const parsed = parseFormula(item, { scopedRefs: true });
      return parsed.ok && containsDocumentMetadata(parsed.ast);
    }
    return containsDocumentMetadata(item);
  });
};

export const compileDocumentQueryExpression = (fn: string, args: Expr[], recordAlias: string) => {
  const format = args[0];
  if (args.length > 1 || (format && (format.kind !== "literal" || typeof format.value !== "string")))
    return formulaSqlFail(`${fn} accepts one optional literal output format`);
  const value = format?.kind === "literal" ? format.value : null;
  if (value !== null && !["pdf", "csv", "json", "xml", "sepa-xml", "datev-csv"].includes(String(value)))
    return formulaSqlFail(`Unknown document output format "${value}"`);
  const formatCondition =
    value === null
      ? sql`TRUE`
      : value === "sepa-xml" || value === "datev-csv"
        ? sql`document.profile_id = ${`grids.${value}`}`
        : sql`COALESCE(document.profile_id, '') NOT IN ('grids.sepa-xml', 'grids.datev-csv') AND EXISTS (
      SELECT 1 FROM grids.document_artifacts artifact JOIN grids.files file ON file.id = artifact.file_id
      WHERE artifact.document_id = document.id AND artifact.artifact_key = document.primary_artifact_key
        AND file.mime_type = ${value === "pdf" ? "application/pdf" : value === "csv" ? "text/csv" : value === "json" ? "application/json" : "application/xml"}
    )`;
  const aggregate = fn === "DOCUMENTCOUNT" ? sql`count(*)::numeric` : sql`max(document.created_at)`;
  return formulaSqlOk(
    sql`(SELECT ${aggregate} FROM grids.documents document
    WHERE ${formatCondition} AND document.id IN (
      SELECT direct.id FROM grids.documents direct
      WHERE direct.table_id = ${sql.unsafe(recordAlias)}.table_id AND direct.record_id = ${sql.unsafe(recordAlias)}.id
      UNION
      SELECT source.document_id FROM grids.document_record_sources source
      WHERE source.table_id = ${sql.unsafe(recordAlias)}.table_id AND source.record_id = ${sql.unsafe(recordAlias)}.id
    ))`,
    fn === "DOCUMENTCOUNT" ? "numeric" : "datetime",
  );
};
