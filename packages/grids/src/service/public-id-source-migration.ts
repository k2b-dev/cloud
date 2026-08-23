import type { SQL } from "bun";
import { type CustomAppDefinitionResourceKind, migrateCustomAppDefinitionV4 } from "../custom-apps/definition-v5";
import { parseFormula } from "../formula/parser";
import type { Expr } from "../formula/types";
import { canonicalizeDslQuery } from "../query-dsl/canonical";
import { parseGridsQueryDsl } from "../query-dsl/parser";
import type { DslResolverContext, DslTableSource, DslViewSource } from "../query-dsl/resolver";
import type { DslQualifiedRef, DslQueryAst, DslSourceRef } from "../query-dsl/types";
import { canonicalizeGridsWorkflowSourceForMigration } from "../workflows/binder";
import { compile as compileCustomAppDefinition } from "./custom-apps";
import type { Field } from "./types";
import { loadWorkflowCatalogForMigration } from "./workflow-catalog";

export type PublicIdMigrationRow = {
  resource: string;
  id: string;
  parentId: string | null;
  oldShortId: string | null;
  newShortId: string;
};

type StoredSourceRow = { id: string; tableId: string; baseId: string; source: string };
type StoredFormulaRow = { id: string; tableId: string; config: unknown };
type CatalogTableRow = { id: string; baseId: string; shortId: string; name: string };
type CatalogViewRow = { id: string; baseId: string; tableId: string; shortId: string; name: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PUBLIC_ID_RE = /^[A-Za-z0-9]{6}$/;
const BRACED_REF_RE = /(?<!\{)\{([^{}]+)\}(?!\})/g;
const LEGACY_FORMULA_REF_RE = /#([A-Za-z0-9_]+)/g;

type MigrationLookup = {
  byUuid: ReadonlyMap<string, string>;
  byScope: ReadonlyMap<string, ReadonlyMap<string, string>>;
};

const scopeKey = (resource: string, parentId: string | null): string => `${resource}:${parentId ?? ""}`;

const migrationLookup = (rows: PublicIdMigrationRow[]): MigrationLookup => {
  const byUuid = new Map<string, string>();
  const scopedCandidates = new Map<string, Map<string, Set<string>>>();
  for (const row of rows) {
    byUuid.set(row.id.toLowerCase(), row.newShortId);
    if (row.oldShortId) {
      const scoped = scopedCandidates.get(scopeKey(row.resource, row.parentId)) ?? new Map<string, Set<string>>();
      const values = scoped.get(row.oldShortId.toLowerCase()) ?? new Set<string>();
      values.add(row.newShortId);
      scoped.set(row.oldShortId.toLowerCase(), values);
      scopedCandidates.set(scopeKey(row.resource, row.parentId), scoped);
    }
  }
  const byScope = new Map<string, ReadonlyMap<string, string>>();
  for (const [scope, candidates] of scopedCandidates) {
    const refs = new Map<string, string>();
    for (const [ref, values] of candidates) {
      if (values.size === 1) refs.set(ref, [...values][0]!);
    }
    byScope.set(scope, refs);
  }
  return { byUuid, byScope };
};

const migratedRef = (ref: string, lookup: MigrationLookup, scopes: string[]): string | undefined => {
  const key = ref.toLowerCase();
  const byUuid = lookup.byUuid.get(key);
  if (byUuid) return byUuid;
  const candidates = new Set(scopes.map((scope) => lookup.byScope.get(scope)?.get(key)).filter((value): value is string => Boolean(value)));
  if (candidates.size > 1) throw new Error(`ambiguous public reference "${ref}" during migration`);
  return [...candidates][0];
};

const rewriteBracedRefs = (source: string, lookup: MigrationLookup, scopes: string[]): string =>
  source.replace(BRACED_REF_RE, (_match, raw: string) => {
    const ref = raw.trim();
    const replacement = migratedRef(ref, lookup, scopes);
    if (replacement) return `{${replacement}}`;
    if (UUID_RE.test(ref) || !PUBLIC_ID_RE.test(ref)) throw new Error(`cannot migrate public reference "${ref}"`);
    return `{${ref}}`;
  });

const rewriteFormulaSource = (source: string, lookup: MigrationLookup, tableId: string): string => {
  const scopes = [scopeKey("fields", tableId)];
  const withoutLegacyRefs = source.replace(LEGACY_FORMULA_REF_RE, (_match, raw: string) => {
    const replacement = migratedRef(raw, lookup, scopes);
    if (!replacement) throw new Error(`cannot migrate legacy formula reference "#${raw}"`);
    return `{${replacement}}`;
  });
  const rewritten = rewriteBracedRefs(withoutLegacyRefs, lookup, scopes);
  const parsed = parseFormula(rewritten);
  if (!parsed.ok) throw new Error(`migrated formula is invalid: ${parsed.error}`);
  return rewritten;
};

const rewriteFormulaRefs = (expression: Expr, rewrite: (ref: string) => string): void => {
  if (expression.kind === "field") {
    const separator = expression.fieldId.indexOf(".");
    expression.fieldId =
      separator === -1
        ? rewrite(expression.fieldId)
        : `${expression.fieldId.slice(0, separator + 1)}${rewrite(expression.fieldId.slice(separator + 1).replace(/^\{?|\}?$/g, ""))}`;
    return;
  }
  if (expression.kind === "call") for (const argument of expression.args) rewriteFormulaRefs(argument, rewrite);
  else if (expression.kind === "unop") rewriteFormulaRefs(expression.operand, rewrite);
  else if (expression.kind === "binop") {
    rewriteFormulaRefs(expression.left, rewrite);
    rewriteFormulaRefs(expression.right, rewrite);
  }
};

const rewriteGqlAstRefs = (ast: DslQueryAst, sourceRef: (ref: string) => string, fieldRef: (ref: string) => string): DslQueryAst => {
  const migrated = structuredClone(ast);
  const source = (ref: DslSourceRef | undefined) => {
    if (ref) ref.ref = sourceRef(ref.ref);
  };
  const field = (ref: DslQualifiedRef) => {
    ref.ref = fieldRef(ref.ref);
  };
  source(migrated.source);
  for (const join of migrated.joins) {
    source(join.source);
    field(join.on.left);
    field(join.on.right);
  }
  for (const item of migrated.select) {
    if (item.kind === "field") field(item.field);
    else rewriteFormulaRefs(item.expression, fieldRef);
  }
  if (migrated.where) rewriteFormulaRefs(migrated.where.expression, fieldRef);
  for (const item of migrated.groupBy) field(item.field);
  for (const item of migrated.aggregations) {
    if (item.argument !== "*") {
      if ("kind" in item.argument && item.argument.kind === "formula") rewriteFormulaRefs(item.argument.expression, fieldRef);
      else field(item.argument as DslQualifiedRef);
    }
  }
  if (migrated.having) rewriteFormulaRefs(migrated.having.expression, fieldRef);
  for (const item of migrated.sort) if (!("kind" in item.target)) field(item.target);
  for (const item of migrated.search?.fields ?? []) field(item);
  return migrated;
};

const rewriteGqlSource = (
  source: string,
  lookup: MigrationLookup,
  scopes: { sources: string[]; fields: string[] },
  context: DslResolverContext,
): string => {
  const recordIdLiquid = "{{ record.id }}";
  const recordIdSentinel = source.includes(recordIdLiquid) ? "MIGR00" : null;
  const dynamicValues = new Map<string, string>();
  let publicValueIndex = 1;
  let identityValueIndex = 1;
  const migrationSource = (recordIdSentinel ? source.replaceAll(recordIdLiquid, recordIdSentinel) : source).replace(
    /@(auth\.(?:subjects|id|name|username|email)|page\.(?:id|title|url)|app\.(?:id|name)|base\.(?:id|name)|time\.(?:now|today|timeZone)|params\.[a-z][a-z0-9_]*)/gi,
    (ref) => {
      const key = ref.slice(1).toLowerCase();
      const value =
        key === "auth.subjects" || key === "auth.id"
          ? `00000000-0000-4000-8000-${String(identityValueIndex++).padStart(12, "0")}`
          : key === "time.today"
            ? "2000-01-01"
            : key === "time.now"
              ? "2000-01-01T00:00:00.000Z"
              : key === "time.timezone"
                ? "UTC"
                : key.endsWith(".id") || key.startsWith("params.")
                  ? `M${String(publicValueIndex++).padStart(5, "0")}`
                  : `migration-${publicValueIndex++}`;
      dynamicValues.set(value, ref);
      return `'${value}'`;
    },
  );
  const uuidRewritten = rewriteBracedRefs(migrationSource, lookup, [...scopes.sources, ...scopes.fields]);
  const parsed = parseGridsQueryDsl(uuidRewritten);
  if (!parsed.ok) throw new Error(`migrated GQL is invalid: ${parsed.diagnostics.map((item) => item.message).join("; ")}`);
  const rewrite = (ref: string, allowedScopes: string[]): string => {
    if (PUBLIC_ID_RE.test(ref)) return ref;
    const aggregate = /^(.*)__(\w+)$/.exec(ref);
    if (aggregate) {
      const migrated = migratedRef(aggregate[1]!, lookup, allowedScopes);
      if (migrated) return `${migrated}__${aggregate[2]}`;
    }
    return migratedRef(ref, lookup, allowedScopes) ?? ref;
  };
  const ast = rewriteGqlAstRefs(
    parsed.ast,
    (ref) => rewrite(ref, scopes.sources),
    (ref) => rewrite(ref, scopes.fields),
  );
  const canonical = canonicalizeDslQuery(ast, context);
  if (!canonical.ok) throw new Error(`migrated GQL cannot resolve: ${canonical.diagnostics.map((item) => item.message).join("; ")}`);
  let canonicalSource = recordIdSentinel ? canonical.source.replaceAll(recordIdSentinel, recordIdLiquid) : canonical.source;
  for (const [value, ref] of dynamicValues) canonicalSource = canonicalSource.replaceAll(`'${value}'`, ref);
  return canonicalSource;
};

export const canonicalizeGqlSourceForPublicIdMigration = (params: {
  source: string;
  rows: PublicIdMigrationRow[];
  sourceScopes: string[];
  fieldScopes: string[];
  context: DslResolverContext;
}): string =>
  rewriteGqlSource(
    params.source,
    migrationLookup(params.rows),
    { sources: params.sourceScopes, fields: params.fieldScopes },
    params.context,
  );

/**
 * Rewrites the persisted declarative sources that predate the six-character
 * public-ID contract. The caller owns the transaction and creates/populates
 * `pg_temp.public_id_migration` before invoking this function.
 *
 * This intentionally rewrites only references recognized by the GQL/formula
 * grammars. It never walks arbitrary JSON strings or replaces UUID-shaped
 * literals in user content.
 */
export const migratePersistedPublicIdReferences = async (db: SQL): Promise<void> => {
  const rows = await db<PublicIdMigrationRow[]>`
    SELECT resource, id::text AS id, parent_id::text AS "parentId",
           old_short_id AS "oldShortId", new_short_id AS "newShortId"
    FROM pg_temp.public_id_migration
  `;
  const lookup = migrationLookup(rows);

  const baseTables = await db<CatalogTableRow[]>`
    SELECT id::text AS id, base_id::text AS "baseId", short_id AS "shortId", name
    FROM grids.tables
  `;
  const catalogViews = await db<CatalogViewRow[]>`
    SELECT view_.id::text AS id, table_.base_id::text AS "baseId", view_.table_id::text AS "tableId",
           view_.short_id AS "shortId", view_.name
    FROM grids.views view_
    JOIN grids.tables table_ ON table_.id = view_.table_id
  `;
  const catalogFields = await db<Array<Field & { baseId: string }>>`
    SELECT field.id::text AS id, field.short_id AS "shortId", field.table_id::text AS "tableId",
           table_.base_id::text AS "baseId", field.name, field.description, field.icon, field.type, field.config,
           field.position, field.required, field.presentable, field.hide_in_table AS "hideInTable",
           field.default_value AS "defaultValue", field.indexed, field.unique_constraint AS "uniqueConstraint",
           field.deleted_at::text AS "deletedAt", field.created_at::text AS "createdAt", field.updated_at::text AS "updatedAt"
    FROM grids.fields field
    JOIN grids.tables table_ ON table_.id = field.table_id
  `;
  const sourceMigrationContext = (
    row: StoredSourceRow,
  ): { scopes: { sources: string[]; fields: string[] }; context: DslResolverContext } => {
    const tableIds = baseTables.filter((table) => table.baseId === row.baseId).map((table) => table.id);
    const tables: DslTableSource[] = baseTables
      .filter((table) => table.baseId === row.baseId)
      .map((table) => ({ kind: "table", id: table.id, shortId: table.shortId, name: table.name }));
    const views: DslViewSource[] = catalogViews
      .filter((view) => view.baseId === row.baseId)
      .map((view) => ({ kind: "view", id: view.id, shortId: view.shortId, name: view.name, tableId: view.tableId, query: {} }));
    const fieldsByTableId = Object.fromEntries(
      tableIds.map((tableId) => [
        tableId,
        catalogFields.filter((field) => field.tableId === tableId).map((field) => ({ ...field, deletedAt: null })),
      ]),
    );
    return {
      scopes: {
        sources: [scopeKey("tables", row.baseId), ...tableIds.map((tableId) => scopeKey("views", tableId))],
        fields: tableIds.map((tableId) => scopeKey("fields", tableId)),
      },
      context: {
        currentTable: tables.find((table) => table.id === row.tableId),
        tables,
        views,
        fieldsByTableId,
      },
    };
  };

  const views = await db<StoredSourceRow[]>`
    SELECT id::text AS id, table_id::text AS "tableId", base_id::text AS "baseId", source FROM grids.views
  `;
  for (const view of views) {
    const migration = sourceMigrationContext(view);
    let source: string;
    try {
      source = rewriteGqlSource(view.source, lookup, migration.scopes, migration.context);
    } catch (error) {
      throw new Error(`cannot migrate view ${view.id}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
    if (source !== view.source) await db`UPDATE grids.views SET source = ${source} WHERE id = ${view.id}::uuid`;
  }

  const templates = await db<StoredSourceRow[]>`
    SELECT template.id::text AS id, template.table_id::text AS "tableId", table_.base_id::text AS "baseId", template.source
    FROM grids.document_templates template
    JOIN grids.tables table_ ON table_.id = template.table_id
  `;
  for (const template of templates) {
    const migration = sourceMigrationContext(template);
    let source: string;
    try {
      source = rewriteGqlSource(template.source, lookup, migration.scopes, migration.context);
    } catch (error) {
      throw new Error(`cannot migrate document template ${template.id}: ${error instanceof Error ? error.message : String(error)}`, {
        cause: error,
      });
    }
    if (source !== template.source) await db`UPDATE grids.document_templates SET source = ${source} WHERE id = ${template.id}::uuid`;
  }

  const formulas = await db<StoredFormulaRow[]>`
    SELECT id::text AS id, table_id::text AS "tableId", config
    FROM grids.fields
    WHERE type = 'formula' AND config ? 'expression'
  `;
  for (const formula of formulas) {
    const config = formula.config as { expression?: unknown };
    if (typeof config.expression !== "string" || !config.expression.trim()) continue;
    const expression = rewriteFormulaSource(config.expression, lookup, formula.tableId);
    if (expression !== config.expression)
      await db`UPDATE grids.fields SET config = jsonb_set(config, '{expression}', to_jsonb(${expression}::text)) WHERE id = ${formula.id}::uuid`;
  }

  const resourceForCustomAppKind: Record<CustomAppDefinitionResourceKind, string> = {
    app: "custom_apps",
    base: "bases",
    table: "tables",
    field: "fields",
    view: "views",
    form: "forms",
    documentTemplate: "document_templates",
    launcher: "workflow_launchers",
  };
  const customApps = await db<Array<{ id: string; baseId: string; draft: unknown; published: unknown | null }>>`
    SELECT id::text AS id, base_id::text AS "baseId", draft_definition AS draft, published_definition AS published
    FROM grids.custom_apps
  `;
  for (const app of customApps) {
    const tableIds = baseTables.filter((table) => table.baseId === app.baseId).map((table) => table.id);
    const parentsByKind: Record<CustomAppDefinitionResourceKind, Array<string | null>> = {
      app: [app.baseId],
      base: [null],
      table: [app.baseId],
      field: tableIds,
      view: tableIds,
      form: tableIds,
      documentTemplate: tableIds,
      launcher: rows.filter((row) => row.resource === "workflow_profile" && row.parentId === app.baseId).map((row) => row.id),
    };
    const resolve = (kind: CustomAppDefinitionResourceKind, legacyId: string): string | null => {
      if (PUBLIC_ID_RE.test(legacyId)) return legacyId;
      return (
        migratedRef(
          legacyId,
          lookup,
          parentsByKind[kind].map((parentId) => scopeKey(resourceForCustomAppKind[kind], parentId)),
        ) ?? null
      );
    };
    const migrateGql = (source: string): string => {
      const candidates = new Set<string>();
      const errors: string[] = [];
      for (const tableId of tableIds) {
        const synthetic: StoredSourceRow = { id: app.id, tableId, baseId: app.baseId, source };
        const migration = sourceMigrationContext(synthetic);
        try {
          candidates.add(rewriteGqlSource(source, lookup, migration.scopes, migration.context));
        } catch (error) {
          errors.push(error instanceof Error ? error.message : String(error));
        }
      }
      if (candidates.size === 1) return [...candidates][0]!;
      if (candidates.size > 1) throw new Error(`custom app GQL resolves against multiple table scopes`);
      throw new Error(errors[0] ?? "custom app GQL has no resolvable table scope");
    };
    const migrate = (definition: unknown): unknown => {
      let migrated: ReturnType<typeof migrateCustomAppDefinitionV4>;
      try {
        migrated = migrateCustomAppDefinitionV4(definition, { resolve, migrateGql });
      } catch (error) {
        throw new Error(`cannot migrate custom app ${app.id}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
      }
      if (!migrated.ok)
        throw new Error(`cannot migrate custom app ${app.id}: ${migrated.diagnostics.map((item) => item.message).join("; ")}`);
      return migrated.definition;
    };
    const formatDiagnostics = (diagnostics: Array<{ path: Array<string | number>; message: string }>) =>
      diagnostics.map((item) => `${item.path.join(".") || "definition"}: ${item.message}`).join("; ");
    const draft = migrate(app.draft);
    const published = app.published === null ? null : migrate(app.published);
    const draftCompilation = await compileCustomAppDefinition(draft, db);
    if (!draftCompilation.ok)
      throw new Error(`cannot compile migrated custom app ${app.id}: ${formatDiagnostics(draftCompilation.diagnostics)}`);
    const publishedCompilation = published === null ? null : await compileCustomAppDefinition(published, db);
    if (publishedCompilation && !publishedCompilation.ok)
      throw new Error(`cannot compile migrated published app ${app.id}: ${formatDiagnostics(publishedCompilation.diagnostics)}`);
    await db`
      UPDATE grids.custom_apps
      SET draft_definition = ${draft}, draft_capabilities = ${draftCompilation.compiled.capabilities},
          published_definition = ${published},
          published_capabilities = ${publishedCompilation?.compiled.capabilities ?? null}
      WHERE id = ${app.id}::uuid
    `;
  }

  const workflowVersions = await db<Array<{ id: string; baseId: string; source: string }>>`
    SELECT version.id::text AS id, profile.base_id::text AS "baseId", version.source
    FROM workflows.version version
    JOIN grids.workflow_profile profile ON profile.id = version.workflow_id
  `;
  await db`ALTER TABLE workflows.version DISABLE TRIGGER version_reject_update`.simple();
  const workflowCatalogs = new Map<string, Awaited<ReturnType<typeof loadWorkflowCatalogForMigration>>>();
  for (const version of workflowVersions) {
    let catalog = workflowCatalogs.get(version.baseId);
    if (!catalog) {
      catalog = await loadWorkflowCatalogForMigration(version.baseId, db);
      workflowCatalogs.set(version.baseId, catalog);
    }
    const aliases = new Map<string, string[]>();
    for (const row of rows) {
      const values = [row.id, row.oldShortId].filter((value): value is string => Boolean(value));
      aliases.set(row.id, values);
    }
    const migrated = await canonicalizeGridsWorkflowSourceForMigration(version.source, catalog, aliases);
    if (!migrated.ok)
      throw new Error(`cannot migrate workflow version ${version.id}: ${migrated.diagnostics.map((item) => item.message).join("; ")}`);
    if (migrated.source === undefined) throw new Error(`cannot migrate workflow version ${version.id}: canonical source is missing`);
    await db`
      UPDATE workflows.version
      SET source = ${migrated.source}, source_hash = ${migrated.plan.sourceHash}, plan = ${migrated.plan}, diagnostics = '[]'::jsonb
      WHERE id = ${version.id}::uuid
    `;
  }
  await db`ALTER TABLE workflows.version ENABLE TRIGGER version_reject_update`.simple();
};
