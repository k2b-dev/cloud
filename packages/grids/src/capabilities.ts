import { err, fail, ok } from "@k2b/stdlib";
import {
  CAPABILITY_MAX_RESULT_BYTES,
  type CapabilityActionReview,
  type CapabilityExecutionContext,
  type CloudResourceRef,
  type CloudResourceView,
  capabilityPage,
  defineCapabilities,
  UniversalSearchDataSchema,
  type UniversalSearchInput,
  UniversalSearchInputSchema,
} from "@valentinkolb/cloud/contracts";
import { get as settingsGet } from "@valentinkolb/cloud/services/settings";
import { normalizeTimeZone } from "@valentinkolb/cloud/shared";
import type { z } from "zod";
import {
  buildPermissionedGqlResolverContextForAccess,
  emptyDslAst,
  executeGqlSourceForContext,
  executeSavedViewSourceForContext,
  type GridsGqlRuntimeContext,
} from "./api/gql-runtime";
import {
  accessActorUser,
  actorViewerFor,
  type GridsAccessContext,
  gateBaseAtAccess,
  gateCredentialScopeFor,
  resourceBoundBaseIdFor,
} from "./api/permissions";
import { isQueryAdmissionError } from "./api/query-admission";
import {
  BaseCapabilityDataSchema,
  BaseListDataSchema,
  BaseListInputSchema,
  BaseReadInputSchema,
  GqlContextDataSchema,
  GqlContextInputSchema,
  type GqlContextItemSchema,
  GqlExecuteInputSchema,
  GqlPreviewInputSchema,
  GqlResultDataSchema,
  GqlViewExecuteInputSchema,
  RecordCapabilityDataSchema,
  RecordCreateInputSchema,
  RecordReadInputSchema,
  RecordUpdateInputSchema,
  TableCapabilityDataSchema,
  TableReadInputSchema,
  ViewCapabilityDataSchema,
  ViewReadInputSchema,
} from "./capability-contracts";
import { type DslQueryPreviewResponse, ShortIdSchema } from "./contracts";
import { isRecordWritableFieldType } from "./field-types";
import { gridsService } from "./service";
import { projectPublicIds, resolvePublicIds } from "./service/public-resources";
import { ALL_RECORD_ACCESS } from "./service/record-access";
import type { Base, Field, GridRecord, Table } from "./service/types";

const GQL_CAPABILITY_RESULT_BUDGET_BYTES = CAPABILITY_MAX_RESULT_BYTES - 32 * 1024;
const REVIEW_VALUES_MAX_CHARS = 9_000;
const REVIEW_VISIBLE_FIELDS = 16;

const capabilityDateConfig = async () => ({
  timeZone: normalizeTimeZone(String((await settingsGet<string>("app.timezone")) || "").trim(), "UTC"),
  locale: "en" as const,
  firstDayOfWeek: 1 as const,
});

const accessContext = (context: CapabilityExecutionContext): GridsAccessContext => ({
  actor: context.actor,
  accessSubject: context.accessSubject,
});

const gqlRuntimeContext = async (context: CapabilityExecutionContext): Promise<GridsGqlRuntimeContext> => ({
  access: accessContext(context),
  dateConfig: await capabilityDateConfig(),
  signal: context.signal,
});

const encodeCursor = (offset: number): string => Buffer.from(JSON.stringify({ v: 1, offset }), "utf8").toString("base64url");

const decodeCursor = (cursor: string | undefined) => {
  if (!cursor) return ok(0);
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { v?: unknown; offset?: unknown };
    return value.v === 1 && Number.isSafeInteger(value.offset) && Number(value.offset) >= 0
      ? ok(Number(value.offset))
      : fail(err.badInput("Invalid cursor"));
  } catch {
    return fail(err.badInput("Invalid cursor"));
  }
};

const mapBase = (base: Base) => ({
  id: base.shortId,
  name: base.name,
  description: base.description,
  createdAt: base.createdAt,
  updatedAt: base.updatedAt,
});

const baseHref = (base: Pick<Base, "shortId">) => `/app/grids/${base.shortId}`;
const tableHref = (base: Pick<Base, "shortId">, table: Pick<Table, "shortId">) => `${baseHref(base)}/table/${table.shortId}`;
const viewHref = (base: Pick<Base, "shortId">, table: Pick<Table, "shortId">, viewShortId: string) =>
  `${tableHref(base, table)}/view/${viewShortId}`;
const recordHref = (base: Pick<Base, "shortId">, table: Pick<Table, "shortId">, recordShortId: string) =>
  `${tableHref(base, table)}?record=${encodeURIComponent(recordShortId)}`;

const visibleBaseParams = (access: GridsAccessContext) => {
  const viewer = actorViewerFor(access);
  const boundBaseId = resourceBoundBaseIdFor(access);
  return { viewer, boundBaseId };
};

const runBaseSearch = async (input: UniversalSearchInput, context: CapabilityExecutionContext) => {
  const access = accessContext(context);
  const scope = await gateCredentialScopeFor(access, "read");
  const { viewer, boundBaseId } = visibleBaseParams(access);
  if (!scope.ok || boundBaseId === null) return ok({ data: [] });
  const result = await gridsService.base.listVisible({
    ...viewer,
    ...(boundBaseId ? { baseId: boundBaseId } : {}),
    query: input.query,
    limit: input.limit,
    offset: 0,
  });
  const data: CloudResourceView[] = result.items.map((base) => ({
    ref: { type: "grids.base", id: base.shortId },
    title: base.name,
    preview: base.description ?? undefined,
    icon: "ti ti-table",
    priority: 7,
    metadata: [{ label: "Type", value: "Base" }],
    links: [{ rel: "open", href: baseHref(base) }],
  }));
  return ok({ data });
};

const runBaseList = async (input: z.infer<typeof BaseListInputSchema>, context: CapabilityExecutionContext) => {
  const cursor = decodeCursor(input.cursor);
  if (!cursor.ok) return cursor;
  const access = accessContext(context);
  const scope = await gateCredentialScopeFor(access, "read");
  if (!scope.ok) return scope;
  const { viewer, boundBaseId } = visibleBaseParams(access);
  if (boundBaseId === null) return fail(err.forbidden("This credential is not bound to a Grids Base."));
  const result = await gridsService.base.listVisible({
    ...viewer,
    ...(boundBaseId ? { baseId: boundBaseId } : {}),
    query: input.query,
    limit: input.limit,
    offset: cursor.data,
  });
  const data = result.items.map((base) => ({
    ...mapBase(base),
    links: [{ rel: "open" as const, href: baseHref(base) }],
  }));
  const nextOffset = cursor.data + data.length;
  const hasMore = nextOffset < result.total;
  return ok({
    data,
    refs: data.map((base) => ({ type: "grids.base", id: base.id })),
    page: capabilityPage(hasMore ? encodeCursor(nextOffset) : undefined),
  });
};

const requireBase = async (baseShortId: string, access: GridsAccessContext) => {
  const base = await gridsService.base.getByShortId(baseShortId);
  if (!base) return fail(err.notFound("Base"));
  const gate = await gateBaseAtAccess(access, base.id, "read");
  if (!gate.ok) return gate;
  return ok(base);
};

const requireTable = async (tableShortId: string, access: GridsAccessContext, required: "read" | "write") => {
  const table = await gridsService.table.getByShortId(tableShortId);
  if (!table) return fail(err.notFound("Table"));
  const gate = await gateBaseAtAccess(access, table.baseId, required);
  return gate.ok ? ok(table) : gate;
};

const gateTableRecordAccess = async (table: Table, access: GridsAccessContext, required: "read" | "write") => {
  const authorization = await gateBaseAtAccess(access, table.baseId, required);
  return authorization.ok ? ok({ table, recordAccess: ALL_RECORD_ACCESS }) : authorization;
};

const requireTableRecordAccess = async (tableShortId: string, access: GridsAccessContext, required: "read" | "write") => {
  const table = await gridsService.table.getByShortId(tableShortId);
  return table ? gateTableRecordAccess(table, access, required) : fail(err.notFound("Table"));
};

const runBaseRead = async (input: z.infer<typeof BaseReadInputSchema>, context: CapabilityExecutionContext) => {
  const result = await requireBase(input.id, accessContext(context));
  if (!result.ok) return result;
  return ok({
    data: mapBase(result.data),
    summary: `Read Grids Base “${result.data.name}”.`,
    refs: [{ type: "grids.base", id: result.data.shortId }],
    links: [{ rel: "open" as const, href: baseHref(result.data) }],
  });
};

const runTableRead = async (input: z.infer<typeof TableReadInputSchema>, context: CapabilityExecutionContext) => {
  const table = await gridsService.table.getByShortId(input.id);
  if (!table) return fail(err.notFound("Table"));
  const permission = await gateBaseAtAccess(accessContext(context), table.baseId, "read");
  if (!permission.ok) return permission;
  if (permission.data === "none") return fail(err.forbidden("You do not have permission to access this resource."));
  const base = await gridsService.base.get(table.baseId);
  if (!base) return fail(err.notFound("Table"));
  return ok({
    data: tableContextItem(table, base, permission.data),
    summary: `Read Grids Table “${table.name}”.`,
    refs: [{ type: "grids.table", id: table.shortId }],
    links: [{ rel: "open" as const, href: tableHref(base, table) }],
  });
};

const runViewRead = async (input: z.infer<typeof ViewReadInputSchema>, context: CapabilityExecutionContext) => {
  const view = await gridsService.view.getByShortId(input.id);
  if (!view) return fail(err.notFound("View"));
  const table = await gridsService.table.get(view.tableId);
  if (!table) return fail(err.notFound("View"));
  const permission = await gateBaseAtAccess(accessContext(context), table.baseId, "read");
  if (!permission.ok) return permission;
  const base = await gridsService.base.get(table.baseId);
  return ok({
    data: {
      kind: "view" as const,
      id: view.shortId,
      tableId: table.shortId,
      name: view.name,
      description: view.description,
      icon: view.icon ?? null,
    },
    summary: `Read Grids View “${view.name}”.`,
    refs: [{ type: "grids.view", id: view.shortId }],
    ...(base ? { links: [{ rel: "open" as const, href: viewHref(base, table, view.shortId) }] } : {}),
  });
};

const selectOptions = (field: Field): Array<{ id: string; label: string; description: string | null }> => {
  const options = (field.config as { options?: unknown }).options;
  if (!Array.isArray(options)) return [];
  return options.flatMap((option) => {
    if (!option || typeof option !== "object") return [];
    const { id, label, description } = option as { id?: unknown; label?: unknown; description?: unknown };
    if (typeof id !== "string" || !id || id.length > 10_000) return [];
    const readableLabel = typeof label === "string" && label.trim() ? label.trim() : id;
    return [{ id, label: readableLabel.slice(0, 500), description: typeof description === "string" ? description.slice(0, 1_000) : null }];
  });
};

const fieldValueHint = (field: Field): string | null => {
  const config = field.config as Record<string, unknown>;
  switch (field.type) {
    case "text":
    case "longtext":
      return "String; use null to clear an optional field.";
    case "number":
      return "Finite number or numeric string; use null to clear an optional field.";
    case "percent":
      return config.range === "fraction" ? "Number from 0 to 1." : "Number from 0 to 100.";
    case "boolean":
      return "Boolean true or false; use null to clear an optional field.";
    case "date":
      return config.includeTime ? "Timezone-aware ISO 8601 date-time string." : "Calendar date string in YYYY-MM-DD format.";
    case "duration":
      return "Non-negative seconds or a MM:SS/HH:MM:SS string.";
    case "select":
      return "Array of option IDs; load them with gql.context kind options for this field.";
    case "principal":
      return 'Array of typed Cloud identity references: { "type": "user"|"group", "id": "<uuid>" }.';
    case "json":
      return "Any JSON value; use null to clear an optional field.";
    case "relation":
      return config.cardinality === "single" ? "One target Record public ID or null." : "Array of target Record public IDs or null.";
    default:
      return null;
  }
};

type GqlContextItem = z.infer<typeof GqlContextItemSchema>;
type TableContextItem = Extract<GqlContextItem, { kind: "table" }>;

const allowsDirectMutations = (table: Table): boolean =>
  table.mutationPolicy.mode === "all" || table.mutationPolicy.sources.includes("direct");

const tableContextItem = (table: Table, base: Base, permission: "read" | "write" | "admin"): TableContextItem => ({
  kind: "table",
  id: table.shortId,
  baseId: base.shortId,
  tableKind: table.kind,
  name: table.name,
  description: table.description,
  icon: table.icon ?? null,
  permission,
  canCreateRecords: table.kind === "stored" && permission !== "read" && allowsDirectMutations(table) && !table.disableDirectInsert,
  canUpdateRecords: table.kind === "stored" && permission !== "read" && allowsDirectMutations(table),
});

const fieldContextItem = (
  field: Field,
  table: Table,
  readableTablesById: ReadonlyMap<string, Table>,
  canUpdateRecords: boolean,
): GqlContextItem => {
  const configuredTarget = (field.config as { targetTableId?: unknown }).targetTableId;
  const targetTableId = typeof configuredTarget === "string" ? (readableTablesById.get(configuredTarget)?.shortId ?? null) : null;
  const configuredCardinality = (field.config as { cardinality?: unknown }).cardinality;
  return {
    kind: "field",
    id: field.shortId,
    tableId: table.shortId,
    name: field.name,
    description: field.description,
    type: field.type,
    position: field.position,
    required: field.required,
    writable: canUpdateRecords && isRecordWritableFieldType(field.type),
    valueHint: fieldValueHint(field),
    targetTableId,
    relationCardinality:
      field.type === "relation" && (configuredCardinality === "single" || configuredCardinality === "multiple")
        ? configuredCardinality
        : field.type === "relation"
          ? "multiple"
          : null,
  };
};

const recordWriteContext = (table: Table, fieldsById: ReadonlyMap<string, Field>, permission: "read" | "write" | "admin") => {
  const canUpdateRecords = table.kind === "stored" && permission !== "read" && allowsDirectMutations(table);
  const updateAudit = canUpdateRecords && table.auditPolicy.update?.enabled ? table.auditPolicy.update : null;
  return {
    tableId: table.shortId,
    canCreateRecords: canUpdateRecords && !table.disableDirectInsert,
    canUpdateRecords,
    updateAudit: updateAudit
      ? {
          scope: updateAudit.scope,
          fieldIds: updateAudit.fieldIds.flatMap((fieldId) => {
            const field = fieldsById.get(fieldId);
            return field ? [field.shortId] : [];
          }),
          questions: auditQuestions(table),
        }
      : null,
  };
};

const auditQuestions = (table: Table) =>
  table.auditPolicy.update?.questions.map((question) => ({
    ...question,
    description: question.description ?? null,
  })) ?? [];

const pageContextItems = (items: GqlContextItem[], offset: number, limit: number) => {
  const data = items.slice(offset, offset + limit);
  const nextOffset = offset + data.length;
  const hasMore = nextOffset < items.length;
  return { data, page: capabilityPage(hasMore ? encodeCursor(nextOffset) : undefined) };
};

const runGqlContext = async (input: z.infer<typeof GqlContextInputSchema>, context: CapabilityExecutionContext) => {
  const cursor = decodeCursor(input.cursor);
  if (!cursor.ok) return cursor;
  const access = accessContext(context);
  const baseResult = await requireBase(input.baseId, access);
  if (!baseResult.ok) return baseResult;

  let items: GqlContextItem[];
  let recordWrite: ReturnType<typeof recordWriteContext> | null = null;
  if (input.kind === "tables") {
    const [resolver, tables] = await Promise.all([
      buildPermissionedGqlResolverContextForAccess(access, baseResult.data.id, undefined, undefined, emptyDslAst()),
      gridsService.table.listByBase(baseResult.data.id),
    ]);
    const tablesById = new Map(tables.map((table) => [table.id, table]));
    const tableItems: TableContextItem[] = resolver.tables.flatMap((source) => {
      const table = tablesById.get(source.id);
      const permission = resolver.tablePermissionsById[source.id];
      return table && permission && permission !== "none"
        ? [
            {
              ...tableContextItem(table, baseResult.data, permission),
              links: [{ rel: "open" as const, href: tableHref(baseResult.data, table) }],
            },
          ]
        : [];
    });
    tableItems.sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
    items = tableItems;
  } else if (input.kind === "fields" || input.kind === "options") {
    if (!input.tableId) return fail(err.badInput(`tableId is required when kind is ${input.kind}`));
    if (input.kind === "options" && !input.fieldId) return fail(err.badInput("fieldId is required when kind is options"));
    const tableResult = await requireTable(input.tableId, access, "read");
    if (!tableResult.ok || tableResult.data.baseId !== baseResult.data.id) return fail(err.notFound("Table"));
    const fieldResult = input.fieldId ? await gridsService.field.getByShortId(input.fieldId) : null;
    if (input.fieldId && (!fieldResult || fieldResult.tableId !== tableResult.data.id)) return fail(err.notFound("Select field"));
    const resolver = await buildPermissionedGqlResolverContextForAccess(
      access,
      baseResult.data.id,
      tableResult.data.id,
      { kind: "table", tableId: tableResult.data.id },
      emptyDslAst(),
    );
    const table = resolver.tables.find((candidate) => candidate.id === tableResult.data.id);
    if (!table) return fail(err.notFound("Table"));
    const permission = resolver.tablePermissionsById[tableResult.data.id];
    if (!permission || permission === "none") return fail(err.notFound("Table"));
    const readableTableIds = new Set(resolver.tables.map((candidate) => candidate.id));
    const readableTablesById = new Map(
      (await gridsService.table.listByBase(baseResult.data.id))
        .filter((candidate) => readableTableIds.has(candidate.id))
        .map((candidate) => [candidate.id, candidate]),
    );
    const fields = (resolver.fieldsByTableId[tableResult.data.id] ?? []).filter((field) => !field.deletedAt);
    const fieldsById = new Map(fields.map((field) => [field.id, field]));
    if (input.kind === "fields") {
      const writeContext = recordWriteContext(tableResult.data, fieldsById, permission);
      recordWrite = writeContext;
      items = fields
        .sort((left, right) => left.position - right.position || left.id.localeCompare(right.id))
        .map((field) => fieldContextItem(field, tableResult.data, readableTablesById, writeContext.canUpdateRecords));
    } else {
      const field = fields.find((candidate) => candidate.id === fieldResult?.id);
      if (!field || field.type !== "select") return fail(err.notFound("Select field"));
      items = selectOptions(field).map((option) => ({ kind: "option" as const, fieldId: field.shortId, ...option }));
    }
  } else {
    let selectedTableId: string | undefined;
    if (input.tableId) {
      const table = await requireTable(input.tableId, access, "read");
      if (!table.ok || table.data.baseId !== baseResult.data.id) return fail(err.notFound("Table"));
      selectedTableId = table.data.id;
    }
    const resolver = await buildPermissionedGqlResolverContextForAccess(access, baseResult.data.id, undefined, undefined, emptyDslAst());
    const views = await gridsService.view.listForTables({
      tableIds: resolver.tables.map((table) => table.id),
      ...actorViewerFor(access),
    });
    const tablesById = new Map(resolver.tables.map((table) => [table.id, table]));
    items = views
      .filter((view) => !selectedTableId || view.tableId === selectedTableId)
      .flatMap((view) => {
        const table = tablesById.get(view.tableId);
        return table
          ? [
              {
                kind: "view" as const,
                id: view.shortId,
                tableId: table.shortId,
                name: view.name,
                description: view.description,
                icon: view.icon ?? null,
                links: [{ rel: "open" as const, href: viewHref(baseResult.data, table, view.shortId) }],
              },
            ]
          : [];
      })
      .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
  }

  const page = pageContextItems(items, cursor.data, input.limit);
  const refs: CloudResourceRef[] = page.data.flatMap((item) =>
    item.kind === "table" || item.kind === "view" ? [{ type: `grids.${item.kind}` as "grids.table" | "grids.view", id: item.id }] : [],
  );
  return ok({
    data: { base: mapBase(baseResult.data), kind: input.kind, items: page.data, recordWrite },
    refs: [{ type: "grids.base", id: baseResult.data.shortId }, ...refs],
    links: [{ rel: "open" as const, href: baseHref(baseResult.data) }],
    page: page.page,
  });
};

type GqlCapabilityOutcome = { kind: "preview" | "execute"; viewName?: string };

const gqlCapabilitySummary = (response: DslQueryPreviewResponse, base: Base, outcome: GqlCapabilityOutcome) => {
  if (!response.ok) {
    return `Grids GQL ${outcome.kind} is invalid with ${response.diagnostics.length} ${response.diagnostics.length === 1 ? "diagnostic" : "diagnostics"}.`;
  }
  const rows = `${response.rows.length} ${response.rows.length === 1 ? "row" : "rows"}`;
  if (outcome.viewName) return `Executed saved Grids View “${outcome.viewName}” with ${rows}.`;
  return `${outcome.kind === "preview" ? "Previewed" : "Executed"} Grids GQL in “${base.name}” with ${rows}.`;
};

const gqlCapabilityResult = async (response: DslQueryPreviewResponse, base: Base, outcome: GqlCapabilityOutcome) => {
  if (!response.ok) {
    const tooLarge = response.diagnostics.find((diagnostic) => diagnostic.message.startsWith("GQL result is too large."));
    return tooLarge
      ? fail(err.badInput(tooLarge.message))
      : ok({
          data: response,
          summary: gqlCapabilitySummary(response, base, outcome),
          refs: [{ type: "grids.base" as const, id: base.shortId }],
          links: [{ rel: "open" as const, href: baseHref(base) }],
        });
  }
  const tableIds = [...new Set(response.rows.flatMap((row) => (row.tableId ? [row.tableId] : [])))];
  const tables = tableIds.length > 0 ? await gridsService.table.listByBase(base.id) : [];
  const wantedTableIds = new Set(tableIds);
  const tablesById = new Map(tables.filter((table) => wantedTableIds.has(table.id)).map((table) => [table.id, table]));
  const columnTableIds = response.columns.flatMap((column) => (column.tableId ? [column.tableId] : []));
  const columnFieldIds = response.columns.flatMap((column) => (column.fieldId ? [column.fieldId] : []));
  const rowRecordIds = response.rows.flatMap((row) => (row.recordId ? [row.recordId] : []));
  const relationRecordIds = response.rows.flatMap((row) =>
    response.columns.flatMap((column) => {
      if (column.type !== "relation") return [];
      const value = row.values[column.key];
      return Array.isArray(value)
        ? value.filter((item): item is string => typeof item === "string")
        : typeof value === "string"
          ? [value]
          : [];
    }),
  );
  const [publicTableIds, publicFieldIds, publicRecordIds] = await Promise.all([
    projectPublicIds("table", [...tableIds, ...columnTableIds]),
    projectPublicIds("field", columnFieldIds),
    projectPublicIds("record", [...rowRecordIds, ...relationRecordIds]),
  ]);
  const publicColumns = response.columns.map((column) => {
    const internalFieldId = column.fieldId;
    const fieldId = internalFieldId ? publicFieldIds.get(internalFieldId) : undefined;
    const tableId = column.tableId ? publicTableIds.get(column.tableId) : undefined;
    let key = column.key;
    if (internalFieldId && fieldId) {
      if (column.key === internalFieldId) key = fieldId;
      else if (column.key.startsWith(`${internalFieldId}__`)) key = `${fieldId}${column.key.slice(internalFieldId.length)}`;
    }
    return {
      ...column,
      key,
      ...(column.tableId ? { tableId } : {}),
      ...(column.fieldId ? { fieldId } : {}),
    };
  });
  if (
    publicColumns.some(
      (column, index) => (response.columns[index]?.tableId && !column.tableId) || (response.columns[index]?.fieldId && !column.fieldId),
    ) ||
    response.rows.some((row) => Boolean(row.tableId) && !publicTableIds.has(row.tableId!)) ||
    rowRecordIds.some((recordId) => !publicRecordIds.has(recordId)) ||
    relationRecordIds.some((recordId) => !publicRecordIds.has(recordId))
  ) {
    return fail(err.internal("Grids could not project a public resource ID."));
  }
  const { page, ...resultData } = response;
  const data = {
    ...resultData,
    columns: publicColumns,
    rows: response.rows.map((row) => {
      const table = row.tableId ? tablesById.get(row.tableId) : undefined;
      const publicRecordId = row.recordId ? publicRecordIds.get(row.recordId) : undefined;
      const publicTableId = row.tableId ? publicTableIds.get(row.tableId) : undefined;
      const values = Object.fromEntries(
        response.columns.map((column, index) => {
          const publicColumn = publicColumns[index]!;
          const value = row.values[column.key];
          const publicValue =
            column.type === "relation"
              ? Array.isArray(value)
                ? value.map((item) => (typeof item === "string" ? (publicRecordIds.get(item) ?? item) : item))
                : typeof value === "string"
                  ? (publicRecordIds.get(value) ?? value)
                  : value
              : value;
          return [publicColumn.key, publicValue];
        }),
      );
      return {
        ...row,
        ...(row.recordId ? { recordId: publicRecordId } : {}),
        ...(row.tableId ? { tableId: publicTableId } : {}),
        values,
        ...(publicRecordId && table ? { links: [{ rel: "open" as const, href: recordHref(base, table, publicRecordId) }] } : {}),
      };
    }),
  };
  const refs: CloudResourceRef[] = [{ type: "grids.base", id: base.shortId }];
  const seen = new Set<string>();
  for (const row of response.rows) {
    if (!row.recordId || seen.has(row.recordId)) continue;
    seen.add(row.recordId);
    const publicRecordId = publicRecordIds.get(row.recordId);
    if (publicRecordId) refs.push({ type: "grids.record", id: publicRecordId });
  }
  const nextCursor = page?.nextCursor ?? undefined;
  return ok({
    data,
    summary: gqlCapabilitySummary(response, base, outcome),
    refs,
    links: [{ rel: "open" as const, href: baseHref(base) }],
    page: capabilityPage(nextCursor),
  });
};

const gqlUnavailable = (error: unknown) =>
  isQueryAdmissionError(error)
    ? { ok: false as const, error: { code: "QUERY_BUSY", message: "Grids is busy. Retry shortly.", status: 503 as const } }
    : Promise.reject(error);

const resolveGqlCurrentSource = async (
  baseId: string,
  input: { currentTableId?: string; currentSource?: { kind: "table"; tableId: string } | { kind: "view"; viewId: string } },
) => {
  const currentTable = input.currentTableId ? await gridsService.table.getByShortId(input.currentTableId) : null;
  if (input.currentTableId && (!currentTable || currentTable.baseId !== baseId)) return fail(err.notFound("Table"));

  if (!input.currentSource) return ok({ currentTableId: currentTable?.id, currentSource: undefined });
  if (input.currentSource.kind === "table") {
    const table = await gridsService.table.getByShortId(input.currentSource.tableId);
    if (!table || table.baseId !== baseId) return fail(err.notFound("Table"));
    return ok({ currentTableId: currentTable?.id, currentSource: { kind: "table" as const, tableId: table.id } });
  }
  const view = await gridsService.view.getByShortId(input.currentSource.viewId);
  if (!view) return fail(err.notFound("View"));
  const table = await gridsService.table.get(view.tableId);
  if (!table || table.baseId !== baseId) return fail(err.notFound("View"));
  return ok({ currentTableId: currentTable?.id, currentSource: { kind: "view" as const, viewId: view.id } });
};

const runGqlPreview = async (input: z.infer<typeof GqlPreviewInputSchema>, context: CapabilityExecutionContext) => {
  const access = accessContext(context);
  const base = await requireBase(input.baseId, access);
  if (!base.ok) return base;
  const current = await resolveGqlCurrentSource(base.data.id, input);
  if (!current.ok) return current;
  try {
    const result = await executeGqlSourceForContext(
      await gqlRuntimeContext(context),
      base.data.id,
      {
        query: input.query,
        currentTableId: current.data.currentTableId,
        currentSource: current.data.currentSource,
        cursor: input.cursor,
        pageSize: input.pageSize,
      },
      { maxRows: 25, maxResultBytes: GQL_CAPABILITY_RESULT_BUDGET_BYTES, operation: "preview", labelRelationValues: false },
    );
    return await gqlCapabilityResult(result.response, base.data, { kind: "preview" });
  } catch (error) {
    return gqlUnavailable(error);
  }
};

const runGqlExecute = async (input: z.infer<typeof GqlExecuteInputSchema>, context: CapabilityExecutionContext) => {
  const access = accessContext(context);
  const base = await requireBase(input.baseId, access);
  if (!base.ok) return base;
  const current = await resolveGqlCurrentSource(base.data.id, input);
  if (!current.ok) return current;
  try {
    const result = await executeGqlSourceForContext(
      await gqlRuntimeContext(context),
      base.data.id,
      {
        query: input.query,
        currentTableId: current.data.currentTableId,
        currentSource: current.data.currentSource,
        cursor: input.cursor,
        pageSize: input.pageSize,
        limit: input.limit,
      },
      { maxRows: 1_000, maxResultBytes: GQL_CAPABILITY_RESULT_BUDGET_BYTES, operation: "execute", labelRelationValues: false },
    );
    return await gqlCapabilityResult(result.response, base.data, { kind: "execute" });
  } catch (error) {
    return gqlUnavailable(error);
  }
};

const runGqlViewExecute = async (input: z.infer<typeof GqlViewExecuteInputSchema>, context: CapabilityExecutionContext) => {
  const base = await requireBase(input.baseId, accessContext(context));
  if (!base.ok) return base;
  const view = await gridsService.view.getByShortId(input.viewId);
  if (!view) return fail(err.notFound("View"));
  const table = await gridsService.table.get(view.tableId);
  if (!table || table.baseId !== base.data.id) return fail(err.notFound("View"));
  try {
    const response = await executeSavedViewSourceForContext(await gqlRuntimeContext(context), base.data.id, view.id, {
      maxRows: 1_000,
      maxResultBytes: GQL_CAPABILITY_RESULT_BUDGET_BYTES,
      pageSize: input.pageSize,
      cursor: input.cursor,
      operation: "execute",
      surface: "api",
      labelRelationValues: false,
    });
    return await gqlCapabilityResult(response, base.data, { kind: "execute", viewName: view.name });
  } catch (error) {
    return gqlUnavailable(error);
  }
};

const mapRecord = (record: GridRecord, table: Table) => ({
  id: record.shortId,
  tableId: table.shortId,
  version: record.version,
  ...(record.finalizedAt ? { finalizedAt: record.finalizedAt, finalizedBy: record.finalizedBy ?? null } : {}),
  deletedAt: record.deletedAt,
  createdBy: record.createdBy,
  updatedBy: record.updatedBy,
  createdAt: record.createdAt,
  updatedAt: record.updatedAt,
});

const recordReviewValue = (value: unknown): string => {
  if (value === null || value === undefined || value === "") return "Clear value";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.length === 0 ? "Clear values" : value.map((item) => `- ${recordReviewValue(item)}`).join("\n");
  return JSON.stringify(value, null, 2);
};

const boundedRecordReviewValue = (value: unknown): string => {
  const full = recordReviewValue(value);
  return full.length > REVIEW_VALUES_MAX_CHARS
    ? `${full.slice(0, REVIEW_VALUES_MAX_CHARS)}\n\nPreview truncated. Review the full validated input under Details.`
    : full;
};

const recordValuesReview = (
  values: Record<string, unknown>,
  fields: ReadonlyArray<Field>,
): NonNullable<CapabilityActionReview["details"]> => {
  const fieldsByShortId = new Map(fields.map((field) => [field.shortId, field]));
  const entries = Object.entries(values);
  const visible = entries.slice(0, REVIEW_VISIBLE_FIELDS).map(([fieldId, value]) => {
    const field = fieldsByShortId.get(fieldId);
    const text = boundedRecordReviewValue(value);
    if (field?.type === "date" && typeof value === "string") {
      return {
        label: field.name,
        value,
        format: field.config.includeTime === true ? ("date-time" as const) : ("date" as const),
      };
    }
    return {
      label: field?.name ?? fieldId,
      value: text,
      ...(((typeof value === "string" && !value.includes("\n") && value.length <= 160) ||
        typeof value === "number" ||
        typeof value === "boolean") &&
      field?.type !== "longtext" &&
      field?.type !== "json"
        ? {}
        : { display: "block" as const }),
    };
  });
  const remaining = entries.slice(REVIEW_VISIBLE_FIELDS);
  if (remaining.length === 0) return visible;
  const additional = remaining
    .map(([fieldId, value]) => `${fieldsByShortId.get(fieldId)?.name ?? fieldId}\n${recordReviewValue(value)}`)
    .join("\n\n");
  return [
    ...visible,
    {
      label: `${remaining.length} additional proposed ${remaining.length === 1 ? "value" : "values"}`,
      value: boundedRecordReviewValue(additional),
      display: "block",
    },
  ];
};

const recordResult = async (record: GridRecord, table: Table, summary?: string) => {
  const base = await gridsService.base.get(table.baseId);
  return ok({
    data: mapRecord(record, table),
    ...(summary ? { summary } : {}),
    refs: [{ type: "grids.record", id: record.shortId }],
    ...(base ? { links: [{ rel: "open" as const, href: recordHref(base, table, record.shortId) }] } : {}),
  });
};

const runRecordRead = async (input: z.infer<typeof RecordReadInputSchema>, context: CapabilityExecutionContext) => {
  const access = accessContext(context);
  const resolved = await gridsService.record.getByShortId(input.id);
  if (!resolved) return fail(err.notFound("Record"));
  const table = await gridsService.table.get(resolved.tableId);
  if (!table) return fail(err.notFound("Record"));
  const tableAccess = await gateTableRecordAccess(table, access, "read");
  if (!tableAccess.ok) return tableAccess;
  const dateConfig = await capabilityDateConfig();
  const record = await gridsService.record.get(table.id, resolved.id, {
    dateConfig,
    viewer: actorViewerFor(access),
    recordAccess: tableAccess.data.recordAccess,
  });
  return record
    ? recordResult(record, tableAccess.data.table, `Read a record in “${tableAccess.data.table.name}” at version ${record.version}.`)
    : fail(err.notFound("Record"));
};

const resolveRecordValues = async (tableId: string, values: Record<string, unknown>) => {
  const fields = await gridsService.field.listByTable(tableId);
  const fieldsByShortId = new Map(fields.filter((field) => !field.deletedAt).map((field) => [field.shortId, field]));
  const entries: Array<{ field: Field; value: unknown }> = [];
  const relationPublicIds: string[] = [];
  for (const [fieldShortId, value] of Object.entries(values)) {
    const field = fieldsByShortId.get(fieldShortId);
    if (!field) return fail(err.badInput(`Unknown Field ID: ${fieldShortId}`));
    entries.push({ field, value });
    if (field.type !== "relation") continue;
    if (Array.isArray(value)) relationPublicIds.push(...value.filter((item): item is string => typeof item === "string"));
    else if (typeof value === "string") relationPublicIds.push(value);
  }
  if (relationPublicIds.some((publicId) => !ShortIdSchema.safeParse(publicId).success)) {
    return fail(err.badInput("Related Record IDs must be 6-character public Grids IDs."));
  }
  const relationIds = await resolvePublicIds("record", relationPublicIds);
  if (relationPublicIds.some((publicId) => !relationIds.has(publicId))) return fail(err.badInput("Unknown related Record ID."));
  const resolved: Record<string, unknown> = {};
  for (const { field, value } of entries) {
    resolved[field.id] =
      field.type === "relation"
        ? Array.isArray(value)
          ? value.map((item) => (typeof item === "string" ? (relationIds.get(item) ?? item) : item))
          : typeof value === "string"
            ? (relationIds.get(value) ?? value)
            : value
        : value;
  }
  return ok({ values: resolved, fields });
};

const runRecordCreate = async (input: z.infer<typeof RecordCreateInputSchema>, context: CapabilityExecutionContext) => {
  const access = accessContext(context);
  const table = await requireTableRecordAccess(input.tableId, access, "write");
  if (!table.ok) return table;
  const values = await resolveRecordValues(table.data.table.id, input.values);
  if (!values.ok) return values;
  const dateConfig = await capabilityDateConfig();
  const result = await gridsService.record.create(table.data.table.id, values.data.values, accessActorUser(access)?.id ?? null, "direct", {
    dateConfig,
    viewer: actorViewerFor(access),
    recordAccess: table.data.recordAccess,
  });
  return result.ok
    ? recordResult(result.data, table.data.table, `Created record ${result.data.shortId} in “${table.data.table.name}”.`)
    : result;
};

const runRecordUpdate = async (input: z.infer<typeof RecordUpdateInputSchema>, context: CapabilityExecutionContext) => {
  if (Object.keys(input.values).length === 0) return fail(err.badInput("values must contain at least one field"));
  const access = accessContext(context);
  const table = await requireTableRecordAccess(input.tableId, access, "write");
  if (!table.ok) return table;
  const record = await gridsService.record.getByShortId(input.recordId);
  if (!record || record.tableId !== table.data.table.id) return fail(err.notFound("Record"));
  const values = await resolveRecordValues(table.data.table.id, input.values);
  if (!values.ok) return values;
  const dateConfig = await capabilityDateConfig();
  const result = await gridsService.record.update(
    table.data.table.id,
    record.id,
    values.data.values,
    accessActorUser(access)?.id ?? null,
    "direct",
    input.ifVersion,
    { dateConfig, viewer: actorViewerFor(access), audit: input.audit, recordAccess: table.data.recordAccess },
  );
  const fieldCount = Object.keys(input.values).length;
  return result.ok
    ? recordResult(
        result.data,
        table.data.table,
        `Updated ${fieldCount} ${fieldCount === 1 ? "field" : "fields"} on record ${result.data.shortId} in “${table.data.table.name}”; the record is now version ${result.data.version}.`,
      )
    : result;
};

export const gridsCapabilities = defineCapabilities({
  protocolVersion: 1,
  types: {
    base: { title: "Grids Base", description: "A permission-scoped Grids workspace.", icon: "ti ti-table", reader: "base.read" },
    table: {
      title: "Grids Table",
      description: "A readable stored or Combined table in a Base.",
      icon: "ti ti-table-column",
      reader: "table.read",
    },
    view: { title: "Grids View", description: "A permission-scoped saved GQL data view.", icon: "ti ti-layout-list", reader: "view.read" },
    record: {
      title: "Grids Record",
      description: "One stable record in a Grids Table.",
      icon: "ti ti-row-insert-bottom",
      reader: "record.read",
    },
  },
  queries: {
    "base.search": {
      title: "Search Grids Bases",
      description:
        "Find an accessible Grids Base by name, description, or short ID when its ID is unknown. Use returned grids.base refs with base.read or their IDs with gql.context and GQL queries.",
      input: UniversalSearchInputSchema,
      data: UniversalSearchDataSchema,
      openWorld: false,
      universalSearch: { tags: [{ tag: "grid", title: "Grids", description: "Show Grids Bases only.", aliases: ["grids"] }] },
      run: runBaseSearch,
    },
    "base.list": {
      title: "List Grids Bases",
      description:
        "Normal entry for Base-scoped Grids work. List accessible Bases and use returned grids.base refs or IDs with base.read, gql.context, gql.preview, gql.execute, or gql.view.execute.",
      input: BaseListInputSchema,
      data: BaseListDataSchema,
      openWorld: false,
      run: runBaseList,
    },
    "base.read": {
      title: "Read Grids Base",
      description: "Read one grids.base ref returned by base.list or base.search.",
      input: BaseReadInputSchema,
      data: BaseCapabilityDataSchema,
      openWorld: false,
      run: runBaseRead,
    },
    "table.read": {
      title: "Read Grids Table",
      description: "Read one grids.table ref returned by gql.context kind tables, including its Base context and effective permission.",
      input: TableReadInputSchema,
      data: TableCapabilityDataSchema,
      openWorld: false,
      run: runTableRead,
    },
    "view.read": {
      title: "Read Grids View",
      description: "Read one grids.view ref returned by gql.context kind views; execute it with gql.view.execute using the same baseId.",
      input: ViewReadInputSchema,
      data: ViewCapabilityDataSchema,
      openWorld: false,
      run: runViewRead,
    },
    "gql.context": {
      title: "Load Grids GQL context",
      description:
        "Load the schema before authoring GQL or record writes. Get baseId from base.list or base.search; request tables first, then fields or select options with returned IDs, or views for gql.view.execute. Field results include write and audit requirements.",
      input: GqlContextInputSchema,
      data: GqlContextDataSchema,
      openWorld: false,
      run: runGqlContext,
    },
    "gql.preview": {
      title: "Preview Grids GQL",
      description:
        "Validate permission-safe GQL after loading IDs with gql.context. Returns a small sample or actionable diagnostics without mutation; pass valid GQL unchanged to gql.execute.",
      input: GqlPreviewInputSchema,
      data: GqlResultDataSchema,
      openWorld: false,
      run: runGqlPreview,
    },
    "gql.execute": {
      title: "Execute Grids GQL",
      description:
        "Execute permission-safe GQL after gql.context and normally gql.preview. Select only needed fields; returned grids.record refs can be opened with record.read, and nextCursor continues byte-bounded pages.",
      input: GqlExecuteInputSchema,
      data: GqlResultDataSchema,
      openWorld: false,
      run: runGqlExecute,
    },
    "gql.view.execute": {
      title: "Execute saved Grids View",
      description:
        "Execute the exact saved query for a baseId and viewId returned by gql.context kind views. This is the direct saved-view path; use gql.execute for ad-hoc GQL and nextCursor for further pages.",
      input: GqlViewExecuteInputSchema,
      data: GqlResultDataSchema,
      openWorld: false,
      run: runGqlViewExecute,
    },
    "record.read": {
      title: "Read Grids Record",
      description:
        "Read one grids.record ref returned by gql.execute, gql.preview, or a record Action. Returns metadata, finalization state, and the current version for record.update; use targeted gql.execute to read field values.",
      input: RecordReadInputSchema,
      data: RecordCapabilityDataSchema,
      openWorld: false,
      run: runRecordRead,
    },
  },
  actions: {
    "record.create": {
      title: "Create Grids Record",
      description:
        "Call gql.context kind fields first, then create once with values keyed by writable Field public ID. Select values use option IDs. Returns bounded metadata; read values with targeted GQL. This action is not idempotent.",
      input: RecordCreateInputSchema,
      data: RecordCapabilityDataSchema,
      destructive: false,
      openWorld: false,
      idempotency: "none",
      run: runRecordCreate,
    },
    "record.update": {
      title: "Update Grids Record",
      description:
        "Load fields for value and audit requirements, then record.read for ifVersion. Only supplied Field public IDs change; stale versions are rejected. Returns bounded metadata; read values with targeted GQL.",
      input: RecordUpdateInputSchema,
      data: RecordCapabilityDataSchema,
      destructive: true,
      openWorld: false,
      idempotency: "none",
      approval: "rememberable",
      review: async (input, context) => {
        if (Object.keys(input.values).length === 0) return fail(err.badInput("values must contain at least one field"));
        const access = accessContext(context);
        const table = await requireTableRecordAccess(input.tableId, access, "write");
        if (!table.ok) return table;
        const resolvedRecord = await gridsService.record.getByShortId(input.recordId);
        if (!resolvedRecord || resolvedRecord.tableId !== table.data.table.id) return fail(err.notFound("Record"));
        const values = await resolveRecordValues(table.data.table.id, input.values);
        if (!values.ok) return values;
        const dateConfig = await capabilityDateConfig();
        const record = await gridsService.record.get(table.data.table.id, resolvedRecord.id, {
          dateConfig,
          viewer: actorViewerFor(access),
          recordAccess: table.data.recordAccess,
        });
        if (!record) return fail(err.notFound("Record"));
        const base = await gridsService.base.get(table.data.table.baseId);
        return ok({
          message: `Update one record in ${table.data.table.name}.`,
          details: [
            { label: "Table", value: table.data.table.name },
            { label: "Record", value: record.shortId },
            { label: "Current version", value: String(record.version) },
            ...recordValuesReview(input.values, values.data.fields),
          ],
          ...(base ? { links: [{ rel: "open" as const, href: recordHref(base, table.data.table, record.shortId) }] } : {}),
        });
      },
      run: runRecordUpdate,
    },
  },
});
