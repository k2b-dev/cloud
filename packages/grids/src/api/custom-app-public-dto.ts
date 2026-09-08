import type { Field, GridRecord } from "../contracts";
import type { executePublishedCustomAppRecords } from "../service/custom-app-records-query";
import { type PublicResourceType, projectPublicIds } from "../service/public-resources";

export const requiredProjected = (ids: ReadonlyMap<string, string>, internalId: string, type: PublicResourceType): string => {
  const publicId = ids.get(internalId);
  if (!publicId) throw new Error(`Missing public id for Grids ${type} ${internalId}`);
  return publicId;
};

const collectUuidValues = (value: unknown, output: Set<string>): void => {
  if (typeof value === "string") {
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) output.add(value);
    return;
  }
  if (Array.isArray(value)) for (const item of value) collectUuidValues(item, output);
};

const projectRecordValues = (
  values: Readonly<Record<string, unknown>>,
  fieldIds: ReadonlyMap<string, string>,
  recordIds: ReadonlyMap<string, string>,
  relationFieldIds: ReadonlySet<string>,
): Record<string, unknown> => {
  const projectValue = (value: unknown): unknown => {
    if (typeof value === "string") return recordIds.get(value) ?? value;
    if (Array.isArray(value)) return value.map(projectValue);
    return value;
  };
  return Object.fromEntries(
    Object.entries(values).map(([fieldId, value]) => [
      fieldIds.get(fieldId) ?? fieldId,
      relationFieldIds.has(fieldId) ? projectValue(value) : value,
    ]),
  );
};

const projectField = (field: Field, tableIds: ReadonlyMap<string, string>, fieldIds: ReadonlyMap<string, string>) => {
  const config = { ...field.config };
  if (typeof config.targetTableId === "string") config.targetTableId = requiredProjected(tableIds, config.targetTableId, "table");
  if (typeof config.displayFieldId === "string") config.displayFieldId = requiredProjected(fieldIds, config.displayFieldId, "field");
  if (typeof config.relationFieldId === "string") config.relationFieldId = requiredProjected(fieldIds, config.relationFieldId, "field");
  if (typeof config.targetFieldId === "string") config.targetFieldId = requiredProjected(fieldIds, config.targetFieldId, "field");
  if (Array.isArray(config.labelFieldIds))
    config.labelFieldIds = config.labelFieldIds.map((id) => (typeof id === "string" ? requiredProjected(fieldIds, id, "field") : id));
  return {
    id: field.shortId,
    tableId: requiredProjected(tableIds, field.tableId, "table"),
    name: field.name,
    description: field.description,
    icon: field.icon,
    type: field.type,
    config,
    position: field.position,
    required: field.required,
    presentable: field.presentable,
    hideInTable: field.hideInTable,
    defaultValue: field.defaultValue,
    indexed: field.indexed,
    uniqueConstraint: field.uniqueConstraint,
    deletedAt: field.deletedAt,
    createdAt: field.createdAt,
    updatedAt: field.updatedAt,
  };
};

export const projectGridRecord = async (record: GridRecord, fields: readonly Field[]) => {
  const relationFieldIds = new Set(fields.filter((field) => field.type === "relation").map((field) => field.id));
  const recordValueIds = new Set<string>();
  for (const [fieldId, value] of Object.entries(record.data)) if (relationFieldIds.has(fieldId)) collectUuidValues(value, recordValueIds);
  const [recordIds, tableIds, fieldIds] = await Promise.all([
    projectPublicIds("record", [record.id, ...recordValueIds]),
    projectPublicIds("table", [record.tableId]),
    projectPublicIds("field", Object.keys(record.data)),
  ]);
  return {
    id: requiredProjected(recordIds, record.id, "record"),
    tableId: requiredProjected(tableIds, record.tableId, "table"),
    data: projectRecordValues(record.data, fieldIds, recordIds, relationFieldIds),
    version: record.version,
    ...(record.finalizedAt ? { finalizedAt: record.finalizedAt, finalizedBy: record.finalizedBy ?? null } : {}),
    deletedAt: record.deletedAt,
    createdBy: record.createdBy,
    updatedBy: record.updatedBy,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
};

export const projectPublishedRecords = async (published: NonNullable<Awaited<ReturnType<typeof executePublishedCustomAppRecords>>>) => {
  const tableInternalIds = new Set([published.primaryTableId]);
  const fieldInternalIds = new Set<string>();
  const recordInternalIds = new Set<string>();
  const fileInternalIds = new Set<string>();
  const addField = (field: Field) => {
    fieldInternalIds.add(field.id);
    tableInternalIds.add(field.tableId);
    const targetTableId = field.config.targetTableId;
    if (typeof targetTableId === "string") tableInternalIds.add(targetTableId);
    const displayFieldId = field.config.displayFieldId;
    if (typeof displayFieldId === "string") fieldInternalIds.add(displayFieldId);
    const relationFieldId = field.config.relationFieldId;
    if (typeof relationFieldId === "string") fieldInternalIds.add(relationFieldId);
    const targetFieldId = field.config.targetFieldId;
    if (typeof targetFieldId === "string") fieldInternalIds.add(targetFieldId);
    const labelFieldIds = field.config.labelFieldIds;
    if (Array.isArray(labelFieldIds)) for (const id of labelFieldIds) if (typeof id === "string") fieldInternalIds.add(id);
  };
  if (published.response.ok) {
    for (const column of published.response.columns) {
      if (column.tableId) tableInternalIds.add(column.tableId);
      if (column.fieldId) fieldInternalIds.add(column.fieldId);
    }
    for (const row of published.response.rows) {
      if (row.recordId) recordInternalIds.add(row.recordId);
      if (row.tableId) tableInternalIds.add(row.tableId);
    }
  }
  for (const field of published.presentation?.fields ?? []) addField(field);
  for (const field of published.cards?.fields ?? []) addField(field);
  const relationFieldIds = new Set(
    [...(published.presentation?.fields ?? []), ...(published.cards?.fields ?? [])]
      .filter((field) => field.type === "relation")
      .map((field) => field.id),
  );
  const relationValueKeys = new Set(relationFieldIds);
  if (published.response.ok)
    for (const column of published.response.columns)
      if (column.fieldId && relationFieldIds.has(column.fieldId)) relationValueKeys.add(column.key);
  if (published.response.ok)
    for (const row of published.response.rows)
      for (const [fieldId, value] of Object.entries(row.values))
        if (relationValueKeys.has(fieldId)) collectUuidValues(value, recordInternalIds);
  for (const record of published.cards?.records ?? []) {
    recordInternalIds.add(record.id);
    tableInternalIds.add(record.tableId);
    Object.keys(record.data).forEach((id) => fieldInternalIds.add(id));
    for (const [fieldId, value] of Object.entries(record.data))
      if (relationFieldIds.has(fieldId)) collectUuidValues(value, recordInternalIds);
  }
  for (const [recordId, params] of Object.entries(published.rowNavigationParams ?? {})) {
    recordInternalIds.add(recordId);
    for (const value of Object.values(params)) recordInternalIds.add(value);
  }
  for (const recordId of Object.keys(published.cards?.relationLabels ?? {})) recordInternalIds.add(recordId);
  for (const [recordId, byField] of Object.entries(published.cards?.filePreviews ?? {})) {
    recordInternalIds.add(recordId);
    for (const [fieldId, preview] of Object.entries(byField)) {
      fieldInternalIds.add(fieldId);
      fieldInternalIds.add(preview.fieldId);
      recordInternalIds.add(preview.recordId);
      fileInternalIds.add(preview.fileId);
    }
  }
  const cardConfig = published.cards?.displayConfig.cards;
  for (const fieldId of cardConfig?.fieldIds ?? []) fieldInternalIds.add(fieldId);
  if (cardConfig?.imageFieldId) fieldInternalIds.add(cardConfig.imageFieldId);
  const calendarConfig = published.cards?.displayConfig.calendar;
  if (calendarConfig?.dateFieldId) fieldInternalIds.add(calendarConfig.dateFieldId);
  const [tableIds, fieldIds, recordIds, fileIds] = await Promise.all([
    projectPublicIds("table", [...tableInternalIds]),
    projectPublicIds("field", [...fieldInternalIds]),
    projectPublicIds("record", [...recordInternalIds]),
    projectPublicIds("file", [...fileInternalIds]),
  ]);
  const response = published.response.ok
    ? {
        ...published.response,
        columns: published.response.columns.map((column) => ({
          ...column,
          ...(column.tableId ? { tableId: requiredProjected(tableIds, column.tableId, "table") } : {}),
          ...(column.fieldId ? { fieldId: requiredProjected(fieldIds, column.fieldId, "field") } : {}),
          key: column.fieldId && column.key === column.fieldId ? requiredProjected(fieldIds, column.fieldId, "field") : column.key,
        })),
        rows: published.response.rows.map((row) => ({
          ...row,
          ...(row.recordId ? { recordId: requiredProjected(recordIds, row.recordId, "record") } : {}),
          ...(row.tableId ? { tableId: requiredProjected(tableIds, row.tableId, "table") } : {}),
          values: Object.fromEntries(
            Object.entries(row.values).map(([key, value]) => [
              fieldIds.get(key) ?? key,
              projectRecordValues({ [key]: value }, new Map(), recordIds, relationValueKeys)[key],
            ]),
          ),
        })),
      }
    : published.response;
  const presentation = published.presentation
    ? { fields: published.presentation.fields.map((field) => projectField(field, tableIds, fieldIds)) }
    : undefined;
  const rowNavigationParams = published.rowNavigationParams
    ? Object.fromEntries(
        Object.entries(published.rowNavigationParams).map(([recordId, params]) => [
          requiredProjected(recordIds, recordId, "record"),
          Object.fromEntries(Object.entries(params).map(([key, value]) => [key, requiredProjected(recordIds, value, "record")])),
        ]),
      )
    : undefined;
  const cards = published.cards
    ? {
        ...published.cards,
        displayConfig: {
          ...published.cards.displayConfig,
          ...(published.cards.displayConfig.cards
            ? {
                cards: {
                  ...published.cards.displayConfig.cards,
                  fieldIds: published.cards.displayConfig.cards.fieldIds?.map((id) => requiredProjected(fieldIds, id, "field")),
                  ...(published.cards.displayConfig.cards.imageFieldId
                    ? { imageFieldId: requiredProjected(fieldIds, published.cards.displayConfig.cards.imageFieldId, "field") }
                    : {}),
                },
              }
            : {}),
          ...(published.cards.displayConfig.calendar?.dateFieldId
            ? {
                calendar: {
                  ...published.cards.displayConfig.calendar,
                  dateFieldId: requiredProjected(fieldIds, published.cards.displayConfig.calendar.dateFieldId, "field"),
                },
              }
            : {}),
        },
        fields: published.cards.fields.map((field) => projectField(field, tableIds, fieldIds)),
        records: published.cards.records.map((record) => ({
          id: requiredProjected(recordIds, record.id, "record"),
          tableId: requiredProjected(tableIds, record.tableId, "table"),
          data: projectRecordValues(record.data, fieldIds, recordIds, relationFieldIds),
          version: record.version,
          ...(record.finalizedAt ? { finalizedAt: record.finalizedAt, finalizedBy: record.finalizedBy ?? null } : {}),
          deletedAt: record.deletedAt,
          createdBy: record.createdBy,
          updatedBy: record.updatedBy,
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
        })),
        relationLabels: Object.fromEntries(
          Object.entries(published.cards.relationLabels).map(([id, label]) => [requiredProjected(recordIds, id, "record"), label]),
        ),
        filePreviews: Object.fromEntries(
          Object.entries(published.cards.filePreviews).map(([recordId, byField]) => [
            requiredProjected(recordIds, recordId, "record"),
            Object.fromEntries(
              Object.entries(byField).map(([fieldId, preview]) => [
                requiredProjected(fieldIds, fieldId, "field"),
                {
                  ...preview,
                  fileId: requiredProjected(fileIds, preview.fileId, "file"),
                  recordId: requiredProjected(recordIds, preview.recordId, "record"),
                  fieldId: requiredProjected(fieldIds, preview.fieldId, "field"),
                },
              ]),
            ),
          ]),
        ),
      }
    : undefined;
  return {
    ...response,
    ...(presentation ? { presentation } : {}),
    ...(cards ? { cards } : {}),
    ...(rowNavigationParams ? { rowNavigationParams } : {}),
  };
};
