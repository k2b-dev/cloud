import { type SQL, sql } from "bun";
import { z } from "zod";
import { parseJsonbRow } from "./jsonb";
import { SHORT_ID_REGEX } from "./short-id";

export type WorkflowCatalogEntry = { id: string; name: string; shortId: string };
/** Record events exist for stored tables only; Combined tables are derived and never emit them. */
export type WorkflowTableCatalogEntry = WorkflowCatalogEntry & { kind: "stored" | "federated" };
export type WorkflowFieldCatalogEntry = WorkflowCatalogEntry & {
  relation?: { targetTableId: string; cardinality: "single" | "multiple" };
};

export type WorkflowCatalogIndex<T extends WorkflowCatalogEntry> = {
  refs: Map<string, T>;
  ambiguous: Set<string>;
};

export type WorkflowCatalog = {
  tables: WorkflowCatalogIndex<WorkflowTableCatalogEntry>;
  fieldsByTable: Map<string, WorkflowCatalogIndex<WorkflowFieldCatalogEntry>>;
  templates: WorkflowCatalogIndex<WorkflowCatalogEntry & { tableId: string }>;
  emailTemplates: WorkflowCatalogIndex<WorkflowCatalogEntry>;
};

const WorkflowCatalogEntrySchema = z.object({ id: z.string().uuid(), name: z.string(), shortId: z.string().regex(SHORT_ID_REGEX) });
const WorkflowTableCatalogEntrySchema = WorkflowCatalogEntrySchema.extend({ kind: z.enum(["stored", "federated"]) });
const WorkflowFieldCatalogEntrySchema = WorkflowCatalogEntrySchema.extend({
  relation: z.object({ targetTableId: z.string().uuid(), cardinality: z.enum(["single", "multiple"]) }).optional(),
});
const WorkflowTemplateCatalogEntrySchema = WorkflowCatalogEntrySchema.extend({ tableId: z.string().uuid() });

export const WorkflowCatalogSnapshotSchema = z.object({
  tables: z.array(WorkflowTableCatalogEntrySchema),
  fieldsByTable: z.record(z.string().uuid(), z.array(WorkflowFieldCatalogEntrySchema)),
  templates: z.array(WorkflowTemplateCatalogEntrySchema),
  emailTemplates: z.array(WorkflowCatalogEntrySchema),
});

export type WorkflowCatalogSnapshot = z.infer<typeof WorkflowCatalogSnapshotSchema>;

type WorkflowCatalogInput = {
  tables: WorkflowTableCatalogEntry[];
  fieldsByTable?: Map<string, WorkflowFieldCatalogEntry[]>;
  templates?: Array<WorkflowCatalogEntry & { tableId: string }>;
  emailTemplates?: WorkflowCatalogEntry[];
};

const createCatalogIndex = <T extends WorkflowCatalogEntry>(): WorkflowCatalogIndex<T> => ({
  refs: new Map<string, T>(),
  ambiguous: new Set<string>(),
});

const addRefAlias = <T extends WorkflowCatalogEntry>(index: WorkflowCatalogIndex<T>, key: string, value: T): void => {
  const existing = index.refs.get(key);
  if (existing && existing.id !== value.id) {
    index.ambiguous.add(key);
    return;
  }
  index.refs.set(key, value);
};

const addRefAliases = <T extends WorkflowCatalogEntry>(index: WorkflowCatalogIndex<T>, value: T): void => {
  if (SHORT_ID_REGEX.test(value.shortId)) addRefAlias(index, value.shortId, value);
  addRefAlias(index, value.name, value);
};

export const buildWorkflowCatalog = (input: WorkflowCatalogInput): WorkflowCatalog => {
  const tables = createCatalogIndex<WorkflowCatalogEntry>();
  for (const table of input.tables) addRefAliases(tables, table);
  const fieldsByTable = new Map<string, WorkflowCatalogIndex<WorkflowFieldCatalogEntry>>();
  for (const [tableId, fields] of input.fieldsByTable ?? new Map()) {
    const index = createCatalogIndex<WorkflowFieldCatalogEntry>();
    for (const field of fields) addRefAliases(index, field);
    fieldsByTable.set(tableId, index);
  }
  const templates = createCatalogIndex<WorkflowCatalogEntry & { tableId: string }>();
  for (const template of input.templates ?? []) addRefAliases(templates, template);
  const emailTemplates = createCatalogIndex<WorkflowCatalogEntry>();
  for (const template of input.emailTemplates ?? []) addRefAliases(emailTemplates, template);
  return { tables, fieldsByTable, templates, emailTemplates };
};

const uniqueEntries = <T extends WorkflowCatalogEntry>(index: WorkflowCatalogIndex<T>): T[] =>
  [...new Map([...index.refs.values()].map((entry) => [entry.id, entry])).values()].sort((left, right) => left.id.localeCompare(right.id));

export const snapshotWorkflowCatalog = (catalog: WorkflowCatalog): WorkflowCatalogSnapshot => ({
  tables: uniqueEntries(catalog.tables),
  fieldsByTable: Object.fromEntries(
    [...catalog.fieldsByTable.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([tableId, fields]) => [tableId, uniqueEntries(fields)]),
  ),
  templates: uniqueEntries(catalog.templates),
  emailTemplates: uniqueEntries(catalog.emailTemplates),
});

export const restoreWorkflowCatalog = (snapshot: WorkflowCatalogSnapshot): WorkflowCatalog =>
  buildWorkflowCatalog({
    tables: snapshot.tables,
    fieldsByTable: new Map(Object.entries(snapshot.fieldsByTable)),
    templates: snapshot.templates,
    emailTemplates: snapshot.emailTemplates,
  });

export const workflowRefDiagnostic = <T extends WorkflowCatalogEntry>(
  index: WorkflowCatalogIndex<T>,
  key: string,
  label: string,
): string | null => {
  if (index.ambiguous.has(key)) return `${label}: ambiguous reference "${key}"`;
  return index.refs.has(key) ? null : `${label}: unknown reference "${key}"`;
};

export const getWorkflowCatalogRef = <T extends WorkflowCatalogEntry>(index: WorkflowCatalogIndex<T>, key: string): T | null => {
  if (index.ambiguous.has(key)) return null;
  return index.refs.get(key) ?? null;
};

const loadWorkflowCatalogWithDeleted = async (baseId: string, db: SQL, includeDeleted: boolean): Promise<WorkflowCatalog> => {
  const tableRows = await db<{ id: string; short_id: string; name: string; kind: string }[]>`
    SELECT id::text AS id, short_id, name, kind
    FROM grids.tables
    WHERE base_id = ${baseId}::uuid AND (${includeDeleted} OR deleted_at IS NULL)
  `;
  const tables = createCatalogIndex<WorkflowTableCatalogEntry>();
  for (const row of tableRows) {
    addRefAliases(tables, { id: row.id, shortId: row.short_id, name: row.name, kind: row.kind === "federated" ? "federated" : "stored" });
  }

  const fieldRows = await db<
    Array<{ id: string; short_id: string; table_id: string; name: string; type: string; config: Record<string, unknown> }>
  >`
    SELECT f.id::text AS id, f.short_id, f.table_id::text AS table_id, f.name, f.type, f.config
    FROM grids.fields f
    JOIN grids.tables t ON t.id = f.table_id AND (${includeDeleted} OR t.deleted_at IS NULL)
    WHERE t.base_id = ${baseId}::uuid AND (${includeDeleted} OR f.deleted_at IS NULL)
  `;
  const fieldsByTable = new Map<string, WorkflowCatalogIndex<WorkflowFieldCatalogEntry>>();
  for (const row of fieldRows) {
    let fields = fieldsByTable.get(row.table_id);
    if (!fields) {
      fields = createCatalogIndex<WorkflowFieldCatalogEntry>();
      fieldsByTable.set(row.table_id, fields);
    }
    const config = parseJsonbRow<Record<string, unknown>>(row.config, {});
    const targetTableId = row.type === "relation" && typeof config.targetTableId === "string" ? config.targetTableId : null;
    const cardinality = config.cardinality === "single" ? "single" : "multiple";
    addRefAliases(fields, {
      id: row.id,
      shortId: row.short_id,
      name: row.name,
      ...(targetTableId ? { relation: { targetTableId, cardinality } } : {}),
    });
  }

  const templateRows = await db<{ id: string; short_id: string; table_id: string; name: string }[]>`
    SELECT dt.id::text AS id, dt.short_id, dt.table_id::text AS table_id, dt.name
    FROM grids.document_templates dt
    JOIN grids.tables t ON t.id = dt.table_id AND (${includeDeleted} OR t.deleted_at IS NULL)
    WHERE t.base_id = ${baseId}::uuid AND (${includeDeleted} OR dt.deleted_at IS NULL)
  `;
  const templates = createCatalogIndex<WorkflowCatalogEntry & { tableId: string }>();
  for (const row of templateRows) {
    addRefAliases(templates, { id: row.id, shortId: row.short_id, tableId: row.table_id, name: row.name });
  }

  const emailTemplateRows = await db<{ id: string; short_id: string; name: string }[]>`
    SELECT et.id::text AS id, et.short_id, et.name
    FROM grids.email_templates et
    JOIN grids.bases b ON b.id = et.base_id AND (${includeDeleted} OR b.deleted_at IS NULL)
    WHERE et.base_id = ${baseId}::uuid AND (${includeDeleted} OR et.deleted_at IS NULL)
  `;
  const emailTemplates = createCatalogIndex<WorkflowCatalogEntry>();
  for (const row of emailTemplateRows) addRefAliases(emailTemplates, { id: row.id, shortId: row.short_id, name: row.name });

  return { tables, fieldsByTable, templates, emailTemplates };
};

export const loadWorkflowCatalog = (baseId: string, db: SQL = sql): Promise<WorkflowCatalog> =>
  loadWorkflowCatalogWithDeleted(baseId, db, false);

/** One-shot public-ID migration catalog; runtime resolution remains live-only. */
export const loadWorkflowCatalogForMigration = (baseId: string, db: SQL): Promise<WorkflowCatalog> =>
  loadWorkflowCatalogWithDeleted(baseId, db, true);

export const resolveWorkflowTableRef = (catalog: WorkflowCatalog, ref: string): WorkflowTableCatalogEntry | null =>
  getWorkflowCatalogRef(catalog.tables, ref);

export const resolveWorkflowFieldRef = (catalog: WorkflowCatalog, tableId: string, ref: string): WorkflowFieldCatalogEntry | null => {
  const fields = catalog.fieldsByTable.get(tableId);
  return fields ? getWorkflowCatalogRef(fields, ref) : null;
};

export const resolveWorkflowTemplateRef = (catalog: WorkflowCatalog, ref: string): (WorkflowCatalogEntry & { tableId: string }) | null =>
  getWorkflowCatalogRef(catalog.templates, ref);

export const resolveWorkflowEmailTemplateRef = (catalog: WorkflowCatalog, ref: string): WorkflowCatalogEntry | null =>
  getWorkflowCatalogRef(catalog.emailTemplates, ref);
