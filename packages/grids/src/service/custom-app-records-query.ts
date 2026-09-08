import type { DslQueryPreviewResponse, Field, GridRecord, RecordDisplayConfig } from "../contracts";
import type { CustomAppCapabilities, CustomAppPage, CustomAppRowNavigation } from "../custom-apps/contracts";
import { createCustomAppFileToken } from "../custom-apps/file-token";
import { projectCustomAppRecord } from "../custom-apps/record-projection";
import { customAppRecordsDisplayFieldHash, isSafeInlineCardImageMimeType } from "../custom-apps/records-display-capability";
import { type CustomAppRecordsLikeBlock, referencedRecordsGqlSource } from "../custom-apps/referenced-records";
import type { DslQueryContextValues } from "../query-dsl/parameters";
import { decodeDslResultCursor, gqlResultFingerprint } from "../query-dsl/result-cursor";
import {
  customAppRecordRelationSnapshot,
  customAppRelationLabelFieldIdsByTableId,
  sameCustomAppRecordRelationSnapshot,
} from "./custom-app-record-relations";
import { executePublishedCustomAppQuery } from "./custom-app-runtime-query";
import { listByTable as listFields } from "./fields";
import { listFirstImagePreviews } from "./files";
import { resolvePublicId, resolvePublicIds } from "./public-resources";
import { createReader } from "./record-read";
import { buildPinnedRelationLabelCache } from "./relation-labels";
import type { ExpansionViewer } from "./relations";
import type { GridFilePreview } from "./types";
import { get as getView } from "./views";

type RecordsCapability = CustomAppCapabilities["views"][number] | CustomAppCapabilities["recordQueries"][number];

type PublishedCustomAppRecordsResult = {
  response: DslQueryPreviewResponse;
  primaryTableId: string;
  rowNavigationParams?: Record<string, Record<string, string>>;
  presentation?: { fields: Field[] };
  cards?: {
    displayConfig: RecordDisplayConfig;
    fields: Field[];
    records: GridRecord[];
    relationLabels: Record<string, string>;
    filePreviews: Record<string, Record<string, GridFilePreview & { contentToken: string }>>;
  };
};

export const customAppRowNavigationParams = (
  navigation: CustomAppRowNavigation,
  recordIds: readonly string[],
  records: readonly GridRecord[],
  relationFieldIds: ReadonlyMap<string, string>,
): Record<string, Record<string, string>> => {
  const recordsById = new Map(records.map((record) => [record.id, record]));
  return Object.fromEntries(
    recordIds.flatMap((recordId) => {
      const record = recordsById.get(recordId);
      const params = Object.fromEntries(
        Object.entries(navigation.params).flatMap(([parameterId, binding]) => {
          if (binding.path === "id") return [[parameterId, recordId]];
          const fieldId = relationFieldIds.get(binding.fieldId);
          const value = fieldId ? record?.data[fieldId] : undefined;
          const targetId = Array.isArray(value) ? value.find((item): item is string => typeof item === "string") : value;
          return typeof targetId === "string" ? [[parameterId, targetId]] : [];
        }),
      );
      return Object.keys(params).length === Object.keys(navigation.params).length ? [[recordId, params]] : [];
    }),
  );
};

/** Executes the exact published Records source used by SSR and row-action admission. */
export const executePublishedCustomAppRecords = async (input: {
  baseId: string;
  customAppId: string;
  publishedAt: string;
  page: CustomAppPage;
  pageParams: Readonly<Record<string, string>>;
  block: CustomAppRecordsLikeBlock;
  capabilities: CustomAppCapabilities;
  context: DslQueryContextValues;
  signal: AbortSignal;
  timeZone: string;
  viewer: ExpansionViewer;
  viewerUserId: string | null;
  viewerServiceAccountId: string | null;
  search?: string;
  cursor?: string;
}): Promise<PublishedCustomAppRecordsResult | null> => {
  const { block } = input;
  const source =
    block.type === "referenced_records"
      ? { kind: "gql" as const, query: referencedRecordsGqlSource(input.page, block) ?? "" }
      : block.source;
  const viewId = source.kind === "view" ? await resolvePublicId("view", source.viewId) : null;
  const view = viewId ? await getView(viewId) : null;
  const capability: RecordsCapability | undefined =
    source.kind === "view"
      ? input.capabilities.views.find((candidate) => candidate.viewId === viewId && candidate.tableId === view?.tableId)
      : input.capabilities.recordQueries.find((candidate) => candidate.pageId === input.page.id && candidate.blockId === block.id);
  if (!capability) return null;
  const publicDisplayFieldIds =
    block.type === "referenced_records" ? block.fieldIds : block.display.kind === "table" ? block.display.columnIds : [];
  const displayFieldIds = await resolvePublicIds("field", publicDisplayFieldIds);
  if (displayFieldIds.size !== publicDisplayFieldIds.length) return null;

  const search = block.searchable ? input.search?.trim().slice(0, 200) || undefined : undefined;
  const cursorSigningKey = process.env.APP_SECRET?.trim();
  if (!cursorSigningKey) throw new Error("APP_SECRET is required for Custom App Records pagination");
  const cursorFingerprint = gqlResultFingerprint({
    baseId: input.baseId,
    canonicalSource: `${capability.planHash}\0${search ?? ""}\0${block.pageSize}`,
    scope: `custom-app-records:${input.page.id}:${block.id}`,
  });
  const cursor = input.cursor ? decodeDslResultCursor(input.cursor, cursorSigningKey) : null;
  if (input.cursor && (!cursor || cursor.fingerprint !== cursorFingerprint || cursor.pageSize !== block.pageSize)) {
    return {
      primaryTableId: "primaryTableId" in capability ? capability.primaryTableId : capability.tableId,
      response: { ok: false, diagnostics: [{ message: "This result cursor is invalid or no longer matches the search." }] },
    };
  }

  const response = await executePublishedCustomAppQuery({
    baseId: input.baseId,
    source: view?.source ?? (source.kind === "gql" ? source.query : ""),
    capability,
    context: input.context,
    signal: input.signal,
    timeZone: input.timeZone,
    viewer: input.viewer,
    ...(view ? { currentTableId: view.tableId, sourceHashScope: view.tableId } : {}),
    maxRows: 100,
    pageSize: block.pageSize,
    cursor,
    cursorFingerprint,
    cursorSigningKey,
    ...(search
      ? {
          search: {
            q: search,
            ...(block.type === "referenced_records"
              ? { allowedFieldIds: block.fieldIds.map((fieldId) => displayFieldIds.get(fieldId)!) }
              : source.kind === "view"
                ? {
                    allowedFieldIds:
                      block.display.kind === "table"
                        ? block.display.columnIds.map((fieldId) => displayFieldIds.get(fieldId)!)
                        : "displayConfig" in capability
                          ? capability.displayConfig?.cards?.fieldIds
                          : undefined,
                  }
                : {}),
          },
        }
      : {}),
    maxResultBytes: 512_000,
    labelRelationValues: true,
  });
  const primaryTableId = "primaryTableId" in capability ? capability.primaryTableId : capability.tableId;
  const fieldTableIds = response.ok
    ? [...new Set(response.columns.flatMap((column) => (column.fieldId && column.tableId ? [column.tableId] : [])))]
    : [];
  const presentationFields = (await Promise.all(fieldTableIds.map((tableId) => listFields(tableId)))).flatMap((fields) =>
    fields.filter((field) => response.ok && response.columns.some((column) => column.fieldId === field.id)),
  );
  const presentation = presentationFields.length > 0 ? { fields: presentationFields } : undefined;
  let rowNavigationParams: Record<string, Record<string, string>> | undefined;
  const rowNavigation = block.type === "records" ? block.rowNavigate : undefined;
  const relationBindings = rowNavigation ? Object.entries(rowNavigation.params).filter(([, binding]) => binding.path === "relation") : [];
  if (response.ok && rowNavigation && relationBindings.length > 0) {
    const allFields = await listFields(primaryTableId);
    const fieldsByShortId = new Map(allFields.map((field) => [field.shortId, field]));
    const bindingsValid = relationBindings.every(([, binding]) => {
      if (binding.path !== "relation") return false;
      const field = fieldsByShortId.get(binding.fieldId);
      const config = field?.config as { cardinality?: unknown; targetTableId?: unknown } | undefined;
      return (
        field?.type === "relation" &&
        config?.cardinality === "single" &&
        response.columns.some((column) => column.tableId === primaryTableId && column.fieldId === field.id)
      );
    });
    if (!bindingsValid) return null;
    const recordIds = response.rows.flatMap((row) => (row.recordId ? [row.recordId] : []));
    const records = await (await createReader(primaryTableId, { fields: allFields })).getMany(recordIds);
    rowNavigationParams = customAppRowNavigationParams(
      rowNavigation,
      recordIds,
      records,
      new Map(allFields.map((field) => [field.shortId, field.id])),
    );
  }
  if (!response.ok || block.display.kind !== "cards") {
    return { response, primaryTableId, presentation, ...(rowNavigationParams ? { rowNavigationParams } : {}) };
  }
  if (block.type === "referenced_records") {
    const fieldsByShortId = new Map(presentationFields.map((field) => [field.shortId, field]));
    const fields = block.fieldIds.flatMap((fieldId) => {
      const field = fieldsByShortId.get(fieldId);
      return field ? [field] : [];
    });
    if (fields.length !== block.fieldIds.length) return null;
    const allFields = await listFields(primaryTableId);
    const recordIds = response.rows.flatMap((row) => (row.recordId ? [row.recordId] : []));
    const records = await (await createReader(primaryTableId, { fields: allFields })).getMany(recordIds);
    const allowedFieldIds = new Set(fields.map((field) => field.id));
    const resultValuesByRecordId = new Map(
      response.rows.flatMap((row) =>
        row.recordId
          ? [
              [
                row.recordId,
                Object.fromEntries(
                  response.columns.flatMap((column) =>
                    column.fieldId && allowedFieldIds.has(column.fieldId) ? [[column.fieldId, row.values[column.key]]] : [],
                  ),
                ),
              ] as const,
            ]
          : [],
      ),
    );
    const projectedRecords = records.map((record) => {
      const projected = projectCustomAppRecord(record, [...allowedFieldIds]);
      return { ...projected, data: { ...projected.data, ...resultValuesByRecordId.get(record.id) } };
    });
    const relationCapability = capability.relationLabels ?? [];
    const relationTargetTableIds = [...new Set(relationCapability.map((relation) => relation.targetTableId))];
    const targetFieldsByTableId = new Map(
      await Promise.all(relationTargetTableIds.map(async (tableId) => [tableId, await listFields(tableId)] as const)),
    );
    const liveRelationLabels = customAppRecordRelationSnapshot(fields, targetFieldsByTableId);
    if (!sameCustomAppRecordRelationSnapshot(relationCapability, liveRelationLabels)) return null;
    const relationTableIds = [primaryTableId, ...relationTargetTableIds];
    const relationLabels = await buildPinnedRelationLabelCache(
      projectedRecords,
      fields,
      customAppRelationLabelFieldIdsByTableId(relationCapability),
      {
        ...input.viewer,
        isAdmin: false,
        readableTableIds: new Set(relationTableIds),
        tableReadAccess: new Map(relationTableIds.map((tableId) => [tableId, true])),
      },
    );
    return {
      response,
      primaryTableId,
      presentation,
      cards: {
        displayConfig: { mode: "cards", cards: { fieldIds: fields.map((field) => field.id) } },
        fields,
        records: projectedRecords,
        relationLabels,
        filePreviews: {},
      },
    };
  }
  if (source.kind !== "view" || !("displayConfig" in capability)) return null;
  const displayConfig = capability.displayConfig;
  const displayFieldHash = capability.displayFieldHash;
  if (displayConfig?.mode !== "cards" || !displayFieldHash) return null;
  const allFields = await listFields(primaryTableId);
  if (customAppRecordsDisplayFieldHash(displayConfig, allFields) !== displayFieldHash) return null;
  const fieldIds = displayConfig.cards?.fieldIds ?? [];
  const fieldsById = new Map(allFields.map((field) => [field.id, field]));
  const fields = fieldIds.flatMap((fieldId) => {
    const field = fieldsById.get(fieldId);
    return field ? [field] : [];
  });
  if (fields.length !== fieldIds.length) return null;
  const recordIds = response.rows.flatMap((row) => (row.recordId ? [row.recordId] : []));
  const records = await (await createReader(primaryTableId, { fields: allFields })).getMany(recordIds);
  const allowedFieldIds = new Set(fieldIds);
  const resultValuesByRecordId = new Map(
    response.rows.flatMap((row) =>
      row.recordId
        ? [
            [
              row.recordId,
              Object.fromEntries(
                response.columns.flatMap((column) =>
                  column.fieldId && allowedFieldIds.has(column.fieldId) ? [[column.fieldId, row.values[column.key]]] : [],
                ),
              ),
            ] as const,
          ]
        : [],
    ),
  );
  const projectedRecords = records.map((record) => {
    const projected = projectCustomAppRecord(record, [...allowedFieldIds]);
    return { ...projected, data: { ...projected.data, ...resultValuesByRecordId.get(record.id) } };
  });
  const relationCapability = capability.relationLabels ?? [];
  const relationTargetTableIds = [...new Set(relationCapability.map((relation) => relation.targetTableId))];
  const targetFieldsByTableId = new Map(
    await Promise.all(relationTargetTableIds.map(async (tableId) => [tableId, await listFields(tableId)] as const)),
  );
  const liveRelationLabels = customAppRecordRelationSnapshot(fields, targetFieldsByTableId);
  if (!sameCustomAppRecordRelationSnapshot(relationCapability, liveRelationLabels)) return null;
  const relationTableIds = [primaryTableId, ...relationTargetTableIds];
  const relationLabels = await buildPinnedRelationLabelCache(
    projectedRecords,
    fields,
    customAppRelationLabelFieldIdsByTableId(relationCapability),
    {
      ...input.viewer,
      isAdmin: false,
      readableTableIds: new Set(relationTableIds),
      tableReadAccess: new Map(relationTableIds.map((tableId) => [tableId, true])),
    },
  );
  const imageFieldId = displayConfig.cards?.imageFieldId;
  const previews = imageFieldId
    ? await listFirstImagePreviews({
        tableId: primaryTableId,
        recordIds,
        fieldIds: [imageFieldId],
      })
    : {};
  const secret = process.env.APP_SECRET?.trim();
  if (imageFieldId && !secret) throw new Error("APP_SECRET is required for Custom App file previews");
  const filePreviews = Object.fromEntries(
    Object.entries(previews).map(([recordId, byField]) => [
      recordId,
      Object.fromEntries(
        Object.entries(byField).flatMap(([fieldId, preview]) =>
          isSafeInlineCardImageMimeType(preview.mimeType)
            ? [
                [
                  fieldId,
                  {
                    ...preview,
                    contentToken: createCustomAppFileToken(
                      {
                        appId: input.customAppId,
                        publishedAt: input.publishedAt,
                        pageId: input.page.id,
                        blockId: block.id,
                        pageParams: { ...input.pageParams },
                        viewerUserId: input.viewerUserId,
                        viewerServiceAccountId: input.viewerServiceAccountId,
                        search: input.search ?? null,
                        cursor: input.cursor ?? null,
                        tableId: primaryTableId,
                        recordId,
                        fieldId,
                        fileId: preview.fileId,
                      },
                      secret!,
                    ),
                  },
                ],
              ]
            : [],
        ),
      ),
    ]),
  );
  return {
    response,
    primaryTableId,
    presentation,
    ...(rowNavigationParams ? { rowNavigationParams } : {}),
    cards: { displayConfig, fields, records: projectedRecords, relationLabels, filePreviews },
  };
};
