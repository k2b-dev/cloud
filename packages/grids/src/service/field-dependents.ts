import { sql } from "@k2b/cloud";
import { TableAuditPolicySchema } from "../contracts";
import { collectFieldRefs, parseFormula } from "../formula/parser";
import { normalizeRefKey } from "../ref-syntax";
import type { SqlClient } from "./audit";

export type FieldDependent = {
  /** Kind of resource that references the field. */
  type: "view" | "form" | "formula" | "lookup" | "rollup" | "relation_display" | "audit_policy" | "federation_mapping";
  /** ID of the dependent resource. */
  resourceId: string;
  /** Human label for error messages. */
  resourceName: string;
  /** Where in the resource the reference lives ("filter", "sort", etc). */
  context?: string;
  /**
   * If true, mutating the field requires the user to remove this dep first.
   * If false, the field-mutation path can auto-cleanup the reference.
   *
   * Views and forms are cleaned automatically. Formula, lookup, rollup, and
   * relation-display dependencies must be removed before the field changes.
   */
  blocking: boolean;
};

type DbRow = Record<string, unknown>;

export const findFieldRefsInValue = (value: unknown, fieldId: string): boolean => {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value === fieldId;
  if (Array.isArray(value)) return value.some((v) => findFieldRefsInValue(v, fieldId));
  if (typeof value === "object") {
    return Object.values(value as Record<string, unknown>).some((v) => findFieldRefsInValue(v, fieldId));
  }
  return false;
};

export const findFieldRefContexts = (config: Record<string, unknown>, fieldId: string): string[] => {
  const contexts: string[] = [];
  // Common keys in view configs that may reference fields.
  const keys = [
    "filter",
    "sort",
    "visibleFields",
    "fieldOrder",
    "fieldWidths",
    "groupBy",
    "groupSort",
    "aggregations",
    "columns",
    "search",
  ];
  for (const key of keys) {
    const part = config[key];
    if (part !== undefined && findFieldRefsInValue(part, fieldId)) {
      contexts.push(key);
    }
  }
  return contexts;
};

/**
 * Returns all resources that reference a field. Required pre-flight check
 * before mutating or deleting the field. Mutation paths consume the result
 * to either auto-cleanup non-blocking refs or surface a "remove dependent
 * first" error to the user.
 *
 * A lookup or rollup on another table can reference the field through a
 * relation, so the dependency scan covers the whole base.
 *
 * Formula references are extracted through the formula parser so both
 * UUID and named references follow the language's actual syntax.
 */
export const getFieldDependents = async (fieldId: string, client: SqlClient = sql): Promise<FieldDependent[]> => {
  const dependents: FieldDependent[] = [];

  // Fetch the source field once so we know its table + base scope. We
  // also need the table's other fields' slug→id map to resolve `#slug`
  // formula refs, and the other tables in the same base for the cross-
  // table relation/lookup/rollup scan.
  const [sourceRow] = await client<DbRow[]>`
    SELECT f.id::text AS id, f.table_id::text AS table_id, t.base_id::text AS base_id
    FROM grids.fields f
    JOIN grids.tables t ON t.id = f.table_id
    WHERE f.id = ${fieldId}::uuid
  `;
  if (!sourceRow) return dependents;
  const sourceTableId = sourceRow.table_id as string;
  const sourceBaseId = sourceRow.base_id as string;

  // ── views ─────────────────────────────────────────────
  // Views store GQL in source and presentation in ui. Both can contain
  // stable field ids, but dependents stay non-blocking because a deleted
  // field should surface as a compile-time view error, not prevent deletion.
  const viewRows = await client<DbRow[]>`
    SELECT v.id, v.name, v.source, v.ui
    FROM grids.views v
    WHERE v.table_id = ${sourceTableId}::uuid AND v.deleted_at IS NULL
  `;
  for (const row of viewRows) {
    const config = { source: row.source, ui: row.ui };
    const contexts = findFieldRefContexts(config, fieldId);
    for (const context of contexts) {
      dependents.push({
        type: "view",
        resourceId: row.id as string,
        resourceName: row.name as string,
        context,
        blocking: false,
      });
    }
  }

  // ── forms ─────────────────────────────────────────────
  // Forms persist field IDs inside their config.fields[]. Keep the scan
  // here so deleting a field auto-cleans form references (UI promises it).
  const formRows = await client<DbRow[]>`
    SELECT fo.id, fo.name, fo.config
    FROM grids.forms fo
    WHERE fo.table_id = ${sourceTableId}::uuid AND fo.deleted_at IS NULL
  `;
  for (const row of formRows) {
    const config = (row.config as { fields?: Array<{ fieldId?: string }> }) ?? {};
    const refs = (config.fields ?? []).filter((f) => f.fieldId === fieldId);
    if (refs.length > 0) {
      dependents.push({
        type: "form",
        resourceId: row.id as string,
        resourceName: row.name as string,
        context: "fields",
        blocking: false,
      });
    }
  }

  // ── record audit policy ────────────────────────────────────────
  // Selected-field update requirements are compliance configuration,
  // not presentation metadata. Silently dropping them would weaken the
  // policy, so the user must update the policy before deleting the field.
  const [tableRow] = await client<{ name: string; audit_policy: unknown }[]>`
    SELECT name, audit_policy
    FROM grids.tables
    WHERE id = ${sourceTableId}::uuid AND deleted_at IS NULL
  `;
  const auditPolicy = TableAuditPolicySchema.safeParse(tableRow?.audit_policy ?? {});
  if (
    auditPolicy.success &&
    auditPolicy.data.update?.enabled &&
    auditPolicy.data.update.scope === "selected" &&
    auditPolicy.data.update.fieldIds.includes(fieldId)
  ) {
    dependents.push({
      type: "audit_policy",
      resourceId: sourceTableId,
      resourceName: `${tableRow?.name ?? "Table"} audit requirements`,
      context: "update fields",
      blocking: true,
    });
  }

  // ── combined-table mappings ───────────────────────────────────
  // Mapping identity is explicit and versioned. Removing either side of a
  // mapping would otherwise make a published revision silently change shape.
  const federationRows = await client<{ table_id: string; table_name: string; context: string }[]>`
    SELECT DISTINCT target.id::text AS table_id, target.name AS table_name,
      CASE WHEN mapping.target_field_id = ${fieldId}::uuid THEN 'canonical field' ELSE 'source field' END AS context
    FROM grids.federated_field_mappings mapping
    JOIN grids.federated_table_revisions revision ON revision.id = mapping.revision_id
    JOIN grids.tables target ON target.id = revision.table_id
    WHERE (mapping.target_field_id = ${fieldId}::uuid OR mapping.source_field_id = ${fieldId}::uuid)
      AND revision.status IN ('draft', 'active', 'degraded')
      AND target.deleted_at IS NULL
  `;
  for (const row of federationRows) {
    dependents.push({
      type: "federation_mapping",
      resourceId: row.table_id,
      resourceName: `${row.table_name} combined-table mapping`,
      context: row.context,
      blocking: true,
    });
  }

  // ── computed / link field configs across the whole base ──────
  // A lookup or rollup can reach this field through a relation from
  // another table, so same-table scanning is insufficient.
  // Both `grids.fields` and `grids.tables` carry an `id` column, so
  // every projection has to be qualified — without aliases Postgres
  // raises 42702 "column reference 'id' is ambiguous". Aliasing both
  // tables also keeps the WHERE legible.
  const candidateFields = await client<DbRow[]>`
    SELECT f.id, f.name, f.type, f.table_id::text AS table_id, f.config
    FROM grids.fields f
    JOIN grids.tables t ON t.id = f.table_id
    WHERE t.base_id = ${sourceBaseId}::uuid
      AND f.deleted_at IS NULL
      AND f.id <> ${fieldId}::uuid
      AND f.type IN ('lookup', 'rollup', 'formula', 'relation')
  `;

  // For each candidate, decide if it references our fieldId. Formula
  // refs need parser-level resolution (slug map) — we build the slug
  // map per source table (the candidate's table, since formulas
  // reference fields on their OWN table).
  const slugMapsByTable = new Map<string, Record<string, string>>();
  const ensureSlugMap = async (tableId: string): Promise<Record<string, string>> => {
    let map = slugMapsByTable.get(tableId);
    if (map) return map;
    const rows = await client<{ id: string; short_id: string; name: string }[]>`
      SELECT id::text AS id, short_id, name
      FROM grids.fields
      WHERE table_id = ${tableId}::uuid AND deleted_at IS NULL AND short_id IS NOT NULL
    `;
    map = {};
    for (const row of rows) {
      map[row.id] = row.id;
      map[row.short_id] = row.id;
      map[normalizeRefKey(row.short_id)] = row.id;
      map[row.name] = row.id;
      map[normalizeRefKey(row.name)] = row.id;
    }
    slugMapsByTable.set(tableId, map);
    return map ?? {};
  };

  for (const row of candidateFields) {
    const config = (row.config as Record<string, unknown>) ?? {};
    const candidateTableId = row.table_id as string;
    const refs: string[] = [];

    // Direct-id refs are flat strings in config — the same shape on
    // every table.
    if (typeof config.relationFieldId === "string") refs.push(config.relationFieldId);
    if (typeof config.targetFieldId === "string") refs.push(config.targetFieldId);

    // Formula refs go through the parser so both `{uuid}` and `#slug`
    // work. The resolved fieldId set goes into `refs` alongside the
    // direct-id refs above.
    if (typeof config.expression === "string") {
      const parsed = parseFormula(config.expression);
      if (parsed.ok) {
        const slugMap = await ensureSlugMap(candidateTableId);
        for (const ref of collectFieldRefs(parsed.ast)) {
          refs.push(slugMap[ref] ?? slugMap[normalizeRefKey(ref)] ?? ref);
        }
      }
    }

    if (refs.includes(fieldId)) {
      const type = row.type as string;
      dependents.push({
        type: type === "formula" ? "formula" : type === "lookup" ? "lookup" : type === "rollup" ? "rollup" : "relation_display",
        resourceId: row.id as string,
        resourceName: row.name as string,
        context: "field-config",
        blocking: true,
      });
    }
  }

  return dependents;
};

/** True if any dependent is blocking — i.e. user must remove deps before mutating. */
export const hasBlockingDependents = (deps: FieldDependent[]): boolean => deps.some((d) => d.blocking);
