import { type AuthContext, getDateConfig, getLocale } from "@k2b/cloud/server";
import { projectPublishedRecords } from "../api/custom-app-public-dto";
import { resolvePublishedCustomAppRuntime } from "../api/custom-app-published-runtime";
import { projectDocuments } from "../api/documents-api-shared";
import { toPublicForm } from "../api/form-api-shared";
import { toPublicGqlResponse } from "../api/gql-public";
import { accessActorUser, actorViewerFor, gridsAccessContext } from "../api/permissions";
import {
  type PublicField,
  type PublicGridFile,
  type PublicGridRecord,
  toPublicFields,
  toPublicFiles,
  toPublicRecord,
  toPublicTable,
} from "../api/public-dto";
import type { Field, GridRecord } from "../contracts";
import { customAppPageRecordFieldIds } from "../custom-apps/conditions";
import type { CustomAppBlock, CustomAppPage } from "../custom-apps/contracts";
import { projectCustomAppRecord } from "../custom-apps/record-projection";
import {
  customAppActionHref,
  customAppActionUrl,
  customAppCommentsUrl,
  customAppDocumentDownloadUrl,
  customAppFormSubmitUrl,
  customAppPageHref,
  customAppRecordFilesUrl,
  customAppRecordsUrl,
  customAppRecordUpdateUrl,
  customAppRowActionUrl,
  customAppScannerUrl,
  customAppSidebarFormSubmitUrl,
} from "../custom-apps/routing";
import { buildCustomAppRuntimeContext, customAppDefinitionWithAvailableNavigation } from "../custom-apps/runtime-context";
import { customAppScannerConfigHash } from "../custom-apps/scanner-capability";
import type { PublicDocument } from "../frontend/_components/documents/public-document-types";
import type { WorkflowScannerState } from "../frontend/_components/workflows/WorkflowScannerSurface";
import type { CustomAppRenderedAction } from "../frontend/custom-app/Actions.island";
import type { CustomAppRecordsSuccess, CustomAppRenderedRowAction } from "../frontend/custom-app/RecordsTable.island";
import { customAppRuntimeMessages } from "../frontend/custom-app/runtime-messages";
import type { CustomAppRenderedSidebarAction } from "../frontend/custom-app/SidebarActions.island";
import { gridsService } from "../service";
import {
  type CustomAppChartData,
  type CustomAppMetricCell,
  chartDataFromPreview,
  metricCellsFromPreview,
} from "../service/custom-app-insights";
import { resolvePublishedCustomAppForm } from "../service/custom-app-published-form";
import { buildCustomAppRecordLabelCache, customAppRecordRelationsMatchPublished } from "../service/custom-app-record-relations";
import { executePublishedCustomAppRecords } from "../service/custom-app-records-query";
import { executePublishedCustomAppQuery, publishedCustomAppAvailability } from "../service/custom-app-runtime-query";
import type { PublicRenderableForm } from "../service/forms";
import { projectPublicIds, resolvePublicId, resolvePublicIds } from "../service/public-resources";
import { scannerLauncherPromptInputSources } from "../workflows/contracts";

type RecordsBlock = Extract<CustomAppBlock, { type: "records" }>;
type ReferencedRecordsBlock = Extract<CustomAppBlock, { type: "referenced_records" }>;
export type RecordsLikeBlock = RecordsBlock | ReferencedRecordsBlock;
type MetricsBlock = Extract<CustomAppBlock, { type: "metrics" }>;
export type ChartBlock = Extract<CustomAppBlock, { type: "chart" }>;
type InsightBlock = MetricsBlock | ChartBlock;
export type RecordBlock = Extract<CustomAppBlock, { type: "record" }>;
type HtmlBlock = Extract<CustomAppBlock, { type: "html" }>;
export type FormBlock = Extract<CustomAppBlock, { type: "form" }>;
type CommentsBlock = Extract<CustomAppBlock, { type: "comments" }>;
type ActionsBlock = Extract<CustomAppBlock, { type: "actions" }>;
type ScannerBlock = Extract<CustomAppBlock, { type: "scanner" }>;
export type BlockResult = { ok: true; result: CustomAppRecordsSuccess } | { ok: false; message: string };
export type MetricsBlockData = { ok: true; cells: CustomAppMetricCell[] } | { ok: false; message: string };
export type ChartBlockData = { ok: true; chart: CustomAppChartData } | { ok: false; message: string };
export type PageRecord = {
  record: PublicGridRecord;
  fields: PublicField[];
  relationLabels: Record<string, string>;
  tableName: string;
  auditPolicy: NonNullable<Awaited<ReturnType<typeof gridsService.table.get>>>["auditPolicy"];
  filesByField: Record<string, PublicGridFile[]>;
  fileEndpoints: Record<string, string>;
};
export type FormBlockData =
  | {
      ok: true;
      form: PublicRenderableForm;
      fields: PublicField[];
      inlineTargetFields: Record<string, PublicField[]>;
      submitUrl: string;
    }
  | { ok: false; message: string };
export type CustomAppDocument = PublicDocument & { downloadUrl: string };
type ResolvedPublishedForm = NonNullable<Awaited<ReturnType<typeof resolvePublishedCustomAppForm>>>;

const preparePublishedForm = async (
  resolved: ResolvedPublishedForm,
): Promise<Omit<Extract<FormBlockData, { ok: true }>, "submitUrl"> | null> => {
  const fixed = new Set(Object.keys(resolved.fixedValues));
  const renderable = gridsService.form.toPublicRenderableForm(resolved.form);
  renderable.config = {
    ...renderable.config,
    redirectUrl: null,
    fields: renderable.config.fields.filter((entry) => !fixed.has(entry.fieldId)),
  };
  const visibleFieldIds = new Set(renderable.config.fields.map((entry) => entry.fieldId));
  const fields = resolved.fields.filter((field) => visibleFieldIds.has(field.id));
  if (fields.length !== visibleFieldIds.size) return null;

  const fieldsById = new Map(resolved.fields.map((field) => [field.id, field]));
  const inlineTargetFields: Record<string, Field[]> = {};
  for (const entry of renderable.config.fields) {
    if (entry.kind !== "user_input" || !entry.inlineCreate?.enabled) continue;
    const relationField = fieldsById.get(entry.fieldId);
    if (relationField?.type !== "relation") continue;
    const targetTableId = (relationField.config as { targetTableId?: unknown }).targetTableId;
    if (typeof targetTableId !== "string") continue;
    const allowedIds = new Set((entry.inlineCreate.fields ?? []).map((field) => field.fieldId));
    inlineTargetFields[targetTableId] = resolved.inlineTargetFields.filter(
      (field) => field.tableId === targetTableId && !field.deletedAt && allowedIds.has(field.id),
    );
  }
  const publicTargetTableIds = await projectPublicIds("table", Object.keys(inlineTargetFields));
  if (publicTargetTableIds.size !== Object.keys(inlineTargetFields).length) return null;
  const publicInlineTargetFields = Object.fromEntries(
    await Promise.all(
      Object.entries(inlineTargetFields).map(async ([tableId, targetFields]) => [
        publicTargetTableIds.get(tableId)!,
        await toPublicFields(targetFields),
      ]),
    ),
  );
  return {
    ok: true,
    form: await toPublicForm({ ...resolved.form, config: renderable.config }),
    fields: await toPublicFields(fields),
    inlineTargetFields: publicInlineTargetFields,
  };
};

const availableIdsInBatches = async <T extends { id: string }>(
  items: readonly T[],
  predicate: (item: T) => Promise<boolean>,
): Promise<Set<string>> => {
  const available = new Set<string>();
  for (let start = 0; start < items.length; start += 8) {
    const batch = items.slice(start, start + 8);
    const results = await Promise.all(batch.map(predicate));
    for (const [index, allowed] of results.entries()) if (allowed) available.add(batch[index]!.id);
  }
  return available;
};

export async function loadPublishedCustomAppPage<T extends AuthContext>(c: import("hono").Context<T>) {
  const { t } = customAppRuntimeMessages.resolve([getLocale(c)]);
  const requestAccess = gridsAccessContext(c);
  const runtime = await resolvePublishedCustomAppRuntime({
    access: requestAccess,
    shortId: c.req.param("shortId") ?? "",
    pageId: c.req.param("pageId"),
    query: c.req.query(),
    dateConfig: getDateConfig(c),
    signal: c.req.raw.signal,
  });
  if (!runtime) return null;
  const { app, definition, capabilities, base, page, pageParams, publicPageParams, dateConfig, runtimeContext, authSubjectIds, viewer } =
    runtime;
  const availabilityCapability = (pageId: string, target: "page" | "block" | "action", blockId?: string, actionId?: string) =>
    capabilities.availability.find(
      (candidate) =>
        candidate.target === target &&
        candidate.pageId === pageId &&
        (target === "page" || (candidate.target !== "page" && candidate.blockId === blockId)) &&
        (target !== "action" || (candidate.target === "action" && candidate.actionId === actionId)),
    );
  const evaluateAvailability = async (
    targetPageId: string,
    queryContext: typeof runtimeContext.query,
    target: "page" | "block" | "action",
    query: string | undefined,
    blockId?: string,
    actionId?: string,
  ) => {
    if (!query) return true;
    const capability = availabilityCapability(targetPageId, target, blockId, actionId);
    if (!capability) return false;
    return publishedCustomAppAvailability({
      baseId: app.baseId,
      source: query,
      capability,
      context: queryContext,
      signal: c.req.raw.signal,
      timeZone: runtimeContext.query["time.timeZone"],
      viewer,
    });
  };
  const available = runtime.available;

  const availableNavigationPageIds = await availableIdsInBatches(
    definition.pages.filter((item) => item.navigation.visible),
    async (candidate) => {
      if (candidate.id === page.id) return true;
      const candidateParams: Record<string, string> = {};
      const candidateContext = buildCustomAppRuntimeContext({
        access: requestAccess,
        app,
        base,
        page: candidate,
        pageUrl: customAppPageHref(app.shortId, candidate.id, candidateParams),
        pageParams: candidateParams,
        dateConfig,
        now: runtimeContext.now,
        authSubjectIds,
      });
      return evaluateAvailability(candidate.id, candidateContext.query, "page", candidate.availableWhen?.query);
    },
  );
  const runtimeDefinition = customAppDefinitionWithAvailableNavigation(definition, availableNavigationPageIds);
  const availableSidebarActionIds = await availableIdsInBatches(definition.sidebar?.actions ?? [], async (action) => {
    return runtime.availableSidebarAction(action.id, action.availableWhen?.query);
  });
  const availableSidebarActions = (definition.sidebar?.actions ?? []).filter((action) => availableSidebarActionIds.has(action.id));

  const visibleBlockIds = await availableIdsInBatches(
    page.rows.flatMap((row) => row.columns.flatMap((column) => column.blocks)),
    (block) =>
      block.type === "comments" && !accessActorUser(requestAccess)
        ? Promise.resolve(false)
        : available("block", block.availableWhen?.query, block.id),
  );
  const runtimePage: CustomAppPage = {
    ...page,
    rows: page.rows.flatMap((row) => {
      const columns = row.columns.flatMap((column) => {
        const blocks = column.blocks.filter((block) => visibleBlockIds.has(block.id));
        return blocks.length > 0 ? [{ ...column, blocks }] : [];
      });
      return columns.length > 0 ? [{ ...row, columns }] : [];
    }),
  };
  const parameterRecords = new Map<string, GridRecord>();
  const parameterTableIds = await resolvePublicIds(
    "table",
    Object.values(page.parameters).map((parameter) => parameter.tableId),
  );
  for (const [parameterId, parameter] of Object.entries(page.parameters)) {
    const tableId = parameterTableIds.get(parameter.tableId);
    const table = tableId ? await gridsService.table.get(tableId) : null;
    if (!table || table.baseId !== app.baseId) return null;
    const record = await gridsService.record.get(table.id, pageParams[parameterId]!, {
      viewer,
      dateConfig,
    });
    if (!record) return null;
    parameterRecords.set(parameterId, record);
  }

  let pageRecord: GridRecord | null = null;
  const pageRecords = new Map<string, PageRecord>();
  const renderedHtml = new Map<string, { html: unknown; fieldName: string }>();
  const recordUpdateEndpoints = new Map<string, string>();
  const documents = new Map<string, CustomAppDocument[]>();
  if (page.record) {
    const tableId = parameterTableIds.get(page.record.tableId);
    if (!tableId) return null;
    const capability = capabilities.records.find((candidate) => candidate.pageId === page.id && candidate.tableId === tableId);
    const publicFieldIds = customAppPageRecordFieldIds(page);
    const publicEditableFieldIds = [
      ...new Set(
        page.rows.flatMap((row) =>
          row.columns.flatMap((column) => column.blocks.flatMap((block) => (block.type === "record" ? block.editableFieldIds : []))),
        ),
      ),
    ].sort();
    const fieldIds = await resolvePublicIds("field", [...publicFieldIds, ...publicEditableFieldIds]);
    if (fieldIds.size !== new Set([...publicFieldIds, ...publicEditableFieldIds]).size) return null;
    const expectedFieldIds = publicFieldIds.map((id) => fieldIds.get(id)!).sort();
    const expectedEditableFieldIds = publicEditableFieldIds.map((id) => fieldIds.get(id)!).sort();
    if (
      !capability ||
      capability.fieldIds.join("\0") !== expectedFieldIds.join("\0") ||
      capability.editableFieldIds.join("\0") !== expectedEditableFieldIds.join("\0")
    ) {
      return null;
    }
    const record = parameterRecords.get(page.record.id.path);
    if (!record) return null;
    const allowed = new Set(capability.fieldIds);
    const fields = (await gridsService.field.listByTable(tableId)).filter((field) => allowed.has(field.id));
    if (fields.length !== allowed.size) return null;
    const table = await gridsService.table.get(tableId);
    if (!table || table.baseId !== app.baseId) return null;
    const publicTable = await toPublicTable(table);
    const relationTargetTableIds = [...new Set(capability.relationLabels.map((relation) => relation.targetTableId))];
    if (!(await customAppRecordRelationsMatchPublished({ baseId: app.baseId, fields, relations: capability.relationLabels }))) return null;
    const relationTableIds = [tableId, ...relationTargetTableIds];
    const relationViewer = {
      ...actorViewerFor(requestAccess),
      isAdmin: false,
      readableTableIds: new Set(relationTableIds),
      tableReadAccess: new Map(relationTableIds.map((tableId) => [tableId, true])),
    };
    const fileFieldIds = fields.filter((field) => field.type === "file").map((field) => field.id);
    const filesByField = await gridsService.file.listForRecord({
      tableId,
      recordId: record.id,
      fieldIds: fileFieldIds,
    });
    pageRecord = record;
    const visibleHtmlBlocks = runtimePage.rows.flatMap((row) =>
      row.columns.flatMap((column) => column.blocks.filter((candidate): candidate is HtmlBlock => candidate.type === "html")),
    );
    const fieldsById = new Map(fields.map((field) => [field.shortId, field]));
    for (const block of visibleHtmlBlocks) {
      const field = fieldsById.get(block.fieldId);
      if (!field || field.type !== "html_template") return null;
      renderedHtml.set(block.id, { html: record.data[field.id], fieldName: field.name });
    }
    const visibleRecordBlocks = runtimePage.rows.flatMap((row) =>
      row.columns.flatMap((column) => column.blocks.filter((candidate): candidate is RecordBlock => candidate.type === "record")),
    );
    for (const block of visibleRecordBlocks) {
      const blockFieldIds = new Set(block.fieldIds.map((id) => fieldIds.get(id)!));
      const blockFields = fields.filter((field) => blockFieldIds.has(field.id));
      const blockRecord = projectCustomAppRecord(record, [...blockFieldIds]);
      const blockRelations = capability.relationLabels.filter((relation) => blockFieldIds.has(relation.fieldId));
      const relationLabels = await buildCustomAppRecordLabelCache({
        records: [blockRecord],
        fields: blockFields,
        relations: blockRelations,
        viewer: relationViewer,
        actorUserId: accessActorUser(requestAccess)?.id ?? null,
      });
      const [publicRecord, publicFields, publicRelationIds] = await Promise.all([
        toPublicRecord(blockRecord, blockFields),
        toPublicFields(blockFields),
        projectPublicIds("record", Object.keys(relationLabels)),
      ]);
      const publicFilesByField = Object.fromEntries(
        await Promise.all(
          blockFields
            .filter((field) => field.type === "file")
            .map(async (field) => [field.shortId, await toPublicFiles(filesByField[field.id] ?? [])]),
        ),
      );
      pageRecords.set(block.id, {
        record: publicRecord,
        fields: publicFields,
        relationLabels: Object.fromEntries(
          Object.entries(relationLabels).flatMap(([id, label]) => {
            const publicId = publicRelationIds.get(id);
            return publicId ? [[publicId, label]] : [];
          }),
        ),
        tableName: table.name,
        auditPolicy: publicTable.auditPolicy,
        filesByField: publicFilesByField,
        fileEndpoints: Object.fromEntries(
          blockFields
            .filter((field) => field.type === "file")
            .map((field) => [field.shortId, customAppRecordFilesUrl(app.shortId, page.id, block.id, field.shortId, publicPageParams)]),
        ),
      });
    }

    if (expectedEditableFieldIds.length > 0 && accessActorUser(requestAccess)) {
      for (const block of runtimePage.rows.flatMap((row) =>
        row.columns.flatMap((column) => column.blocks.filter((candidate): candidate is RecordBlock => candidate.type === "record")),
      )) {
        if (block.editableFieldIds.length > 0) {
          recordUpdateEndpoints.set(block.id, customAppRecordUpdateUrl(app.shortId, page.id, block.id, publicPageParams));
        }
      }
    }

    const documentBlocks = runtimePage.rows.flatMap((row) =>
      row.columns.flatMap((column) =>
        column.blocks.filter((candidate): candidate is RecordBlock => candidate.type === "record" && Boolean(candidate.documents)),
      ),
    );
    const configuredTemplateIds = new Set<string>();
    const publicTemplateIds = documentBlocks.flatMap((block) => block.documents?.templateIds ?? []);
    const templateIds = await resolvePublicIds("documentTemplate", publicTemplateIds);
    if (templateIds.size !== new Set(publicTemplateIds).size) return null;
    for (const block of documentBlocks) {
      const expectedTemplateIds = (block.documents?.templateIds ?? []).map((id) => templateIds.get(id)!).sort();
      const capability = capabilities.documents.find(
        (candidate) => candidate.pageId === page.id && candidate.blockId === block.id && candidate.tableId === tableId,
      );
      if (!capability || capability.templateIds.join("\0") !== expectedTemplateIds.join("\0")) return null;
      for (const templateId of expectedTemplateIds) configuredTemplateIds.add(templateId);
    }
    const readableTemplateIds: string[] = [];
    for (const templateId of configuredTemplateIds) {
      const template = await gridsService.document.getTemplate(templateId);
      if (!template || template.tableId !== tableId) continue;
      readableTemplateIds.push(templateId);
    }
    const documentSummaries = await gridsService.document.listDocumentSummariesForRecordByTemplates(
      tableId,
      record.id,
      readableTemplateIds,
    );
    const projectedDocuments = await projectDocuments(documentSummaries);
    for (const block of documentBlocks) {
      const allowed = new Set((block.documents?.templateIds ?? []).map((id) => templateIds.get(id)!));
      documents.set(
        block.id,
        documentSummaries.flatMap((documentSummary, index) => {
          const document = projectedDocuments[index];
          return document && allowed.has(documentSummary.templateId)
            ? [
                {
                  ...document,
                  downloadUrl: customAppDocumentDownloadUrl(app.shortId, page.id, block.id, document.id, publicPageParams),
                },
              ]
            : [];
        }),
      );
    }
  }

  const blocks = runtimePage.rows.flatMap((row) =>
    row.columns.flatMap((column) =>
      column.blocks.filter((block): block is RecordsLikeBlock => block.type === "records" || block.type === "referenced_records"),
    ),
  );
  const entries = await Promise.all(
    blocks.map(async (block): Promise<[string, BlockResult]> => {
      try {
        const published = await executePublishedCustomAppRecords({
          baseId: app.baseId,
          customAppId: app.id,
          publishedAt: app.publishedAt!,
          page,
          pageParams,
          block,
          capabilities,
          context: runtimeContext.query,
          signal: c.req.raw.signal,
          timeZone: runtimeContext.query["time.timeZone"],
          viewer,
          viewerUserId: viewer.userId,
          viewerServiceAccountId: viewer.serviceAccountId ?? null,
        });
        if (!published) return [block.id, { ok: false, message: t.dataSourceNotPublished }];
        if (!published.response.ok) {
          return [block.id, { ok: false, message: published.response.diagnostics[0]?.message ?? t.dataSourceUnavailable }];
        }
        const projected = await projectPublishedRecords(published);
        if (!projected.ok) return [block.id, { ok: false, message: t.dataSourceUnavailable }];
        return [
          block.id,
          {
            ok: true,
            result: projected,
          },
        ];
      } catch {
        return [block.id, { ok: false, message: t.dataSourceTemporarilyUnavailable }];
      }
    }),
  );
  const results = new Map(entries);
  const insightBlocks = runtimePage.rows.flatMap((row) =>
    row.columns.flatMap((column) =>
      column.blocks.filter((block): block is InsightBlock => block.type === "metrics" || block.type === "chart"),
    ),
  );
  const insightEntries = await Promise.all(
    insightBlocks.map(async (block): Promise<[string, MetricsBlockData | ChartBlockData]> => {
      const source = block.source;
      const viewId = source.kind === "view" ? await resolvePublicId("view", source.viewId) : null;
      const capability = capabilities.insights.find(
        (candidate) =>
          candidate.pageId === page.id &&
          candidate.blockId === block.id &&
          candidate.blockType === block.type &&
          candidate.source.kind === source.kind &&
          (candidate.source.kind !== "view" || (source.kind === "view" && candidate.source.viewId === viewId)),
      );
      if (!capability) return [block.id, { ok: false, message: t.dataSourceNotPublished }];
      const maxRows = block.type === "metrics" ? 1 : block.limit;
      try {
        const view = viewId ? await gridsService.view.get(viewId) : null;
        if (source.kind === "view" && (!view || capability.source.kind !== "view")) {
          return [block.id, { ok: false, message: t.savedViewChanged }];
        }
        const response = await executePublishedCustomAppQuery({
          baseId: app.baseId,
          source: view?.source ?? (source.kind === "gql" ? source.query : ""),
          capability: capability.source,
          context: runtimeContext.query,
          signal: c.req.raw.signal,
          timeZone: runtimeContext.query["time.timeZone"],
          viewer,
          ...(view ? { currentTableId: view.tableId, sourceHashScope: view.tableId } : {}),
          maxRows,
          maxResultBytes: 512_000,
          labelRelationValues: true,
        });
        if (!response.ok) {
          return [block.id, { ok: false, message: t.dataSourceUnavailable }];
        }
        const outputTableIds = [...new Set(response.columns.flatMap((column) => (column.tableId ? [column.tableId] : [])))];
        const fieldGroups = await gridsService.field.listByTables(outputTableIds);
        const selectedFieldIds = new Set(response.columns.flatMap((column) => (column.fieldId ? [column.fieldId] : [])));
        const [publicResponse, sourceFields] = await Promise.all([
          toPublicGqlResponse(response),
          toPublicFields(
            outputTableIds.flatMap((tableId) => fieldGroups.get(tableId) ?? []).filter((field) => selectedFieldIds.has(field.id)),
          ),
        ]);
        if (!publicResponse.ok) return [block.id, { ok: false, message: t.dataSourceUnavailable }];
        if (block.type === "metrics") return [block.id, { ok: true, cells: metricCellsFromPreview(publicResponse, sourceFields) }];
        const chart = chartDataFromPreview(publicResponse, sourceFields);
        if (chart.kind === "error") return [block.id, { ok: false, message: t.chartDataUnavailable }];
        return [block.id, { ok: true, chart }];
      } catch {
        return [block.id, { ok: false, message: t.dataSourceTemporarilyUnavailable }];
      }
    }),
  );
  const metrics = new Map<string, MetricsBlockData>();
  const charts = new Map<string, ChartBlockData>();
  for (const [blockId, data] of insightEntries) {
    const block = insightBlocks.find((candidate) => candidate.id === blockId);
    if (block?.type === "metrics") metrics.set(blockId, data as MetricsBlockData);
    if (block?.type === "chart") charts.set(blockId, data as ChartBlockData);
  }
  const commentBlocks = runtimePage.rows.flatMap((row) =>
    row.columns.flatMap((column) => column.blocks.filter((block): block is CommentsBlock => block.type === "comments")),
  );
  const commentEndpoints = new Map<string, string>();
  for (const block of commentBlocks) {
    const capability = capabilities.comments.find(
      (candidate) => candidate.pageId === page.id && candidate.blockId === block.id && candidate.tableId === pageRecord?.tableId,
    );
    if (!capability || !page.record || !pageRecord) return null;
    commentEndpoints.set(block.id, customAppCommentsUrl(app.shortId, page.id, block.id, publicPageParams));
  }
  const formBlocks = runtimePage.rows.flatMap((row) =>
    row.columns.flatMap((column) => column.blocks.filter((block): block is FormBlock => block.type === "form")),
  );
  const formEntries = await Promise.all(
    formBlocks.map(async (block): Promise<[string, FormBlockData]> => {
      const resolvedForm = await resolvePublishedCustomAppForm({ surface: block, page, capabilities });
      if (!resolvedForm) {
        return [block.id, { ok: false, message: t.thisFormUnavailable }];
      }
      const prepared = await preparePublishedForm(resolvedForm);
      if (!prepared) {
        return [block.id, { ok: false, message: t.formChanged }];
      }
      return [
        block.id,
        {
          ...prepared,
          submitUrl: customAppFormSubmitUrl(app.shortId, page.id, block.id, publicPageParams),
        },
      ];
    }),
  );
  const forms = new Map(formEntries);
  const sidebarActions: CustomAppRenderedSidebarAction[] = [];
  for (const action of availableSidebarActions) {
    const resolvedForm = await resolvePublishedCustomAppForm({ surface: action, capabilities });
    if (!resolvedForm) continue;
    const prepared = await preparePublishedForm(resolvedForm);
    if (!prepared) continue;
    sidebarActions.push({
      id: action.id,
      kind: "form",
      label: action.label,
      icon: action.icon,
      tone: action.tone,
      submitUrl: customAppSidebarFormSubmitUrl(app.shortId, action.id),
      form: prepared.form,
      fields: prepared.fields,
      inlineTargetFields: prepared.inlineTargetFields,
      dateConfig,
    });
  }
  const actionBlocks = runtimePage.rows.flatMap((row) =>
    row.columns.flatMap((column) => column.blocks.filter((block): block is ActionsBlock => block.type === "actions")),
  );
  const actions = new Map<string, CustomAppRenderedAction[]>();
  for (const block of actionBlocks) {
    const rendered: CustomAppRenderedAction[] = [];
    for (const action of block.actions) {
      if (!(await available("action", action.availableWhen?.query, block.id, action.id))) continue;
      if (action.kind === "navigate") {
        const href = customAppActionHref(app.shortId, action, publicPageParams, pageRecord?.shortId);
        if (href) rendered.push({ id: action.id, kind: "navigate", label: action.label, icon: action.icon, href, history: action.history });
        continue;
      }
      if (!accessActorUser(requestAccess)) continue;
      const launcherId = await resolvePublicId("workflowLauncher", action.launcherId);
      const capability = capabilities.workflowLaunchers.find(
        (candidate) =>
          "pageId" in candidate &&
          candidate.pageId === page.id &&
          candidate.blockId === block.id &&
          candidate.actionId === action.id &&
          candidate.launcherId === launcherId,
      );
      if (capability) {
        rendered.push({
          id: action.id,
          kind: "workflow",
          label: action.label,
          icon: action.icon,
          endpoint: customAppActionUrl(app.shortId, page.id, block.id, action.id, publicPageParams),
          confirm: action.confirm,
        });
      }
    }
    actions.set(block.id, rendered);
  }
  const rowActions = new Map<string, CustomAppRenderedRowAction[]>();
  const recordEndpoints = new Map<string, string>();
  for (const block of blocks) {
    recordEndpoints.set(block.id, customAppRecordsUrl(app.shortId, page.id, block.id, publicPageParams));
    const rendered: CustomAppRenderedRowAction[] = [];
    if (accessActorUser(requestAccess)) {
      for (const action of block.rowActions ?? []) {
        if (!(await available("action", action.availableWhen?.query, block.id, action.id))) continue;
        const launcherId = await resolvePublicId("workflowLauncher", action.launcherId);
        const capability = capabilities.workflowLaunchers.find(
          (candidate) =>
            "pageId" in candidate &&
            candidate.pageId === page.id &&
            candidate.blockId === block.id &&
            candidate.actionId === action.id &&
            candidate.launcherId === launcherId,
        );
        if (!capability) continue;
        rendered.push({
          id: action.id,
          label: action.label,
          icon: action.icon,
          showLabel: action.showLabel,
          endpoint: customAppRowActionUrl(app.shortId, page.id, block.id, action.id, publicPageParams),
          confirm: action.confirm,
        });
      }
    }
    rowActions.set(block.id, rendered);
  }
  const scanners = new Map<string, { state: WorkflowScannerState; endpoint: string }>();
  if (accessActorUser(requestAccess)) {
    const scannerBlocks = runtimePage.rows.flatMap((row) =>
      row.columns.flatMap((column) => column.blocks.filter((block): block is ScannerBlock => block.type === "scanner")),
    );
    for (const block of scannerBlocks) {
      const launcherId = await resolvePublicId("workflowLauncher", block.launcherId);
      const capability = capabilities.scannerLaunchers.find(
        (candidate) => candidate.pageId === page.id && candidate.blockId === block.id && candidate.launcherId === launcherId,
      );
      if (!capability) continue;
      const [launcher, workflow] = await Promise.all([
        gridsService.workflow.launcher.get(capability.launcherId),
        gridsService.workflow.get(capability.workflowId),
      ]);
      if (
        !launcher ||
        launcher.config.kind !== "scanner" ||
        !launcher.enabled ||
        launcher.workflowId !== capability.workflowId ||
        launcher.validatedRevision !== capability.revision ||
        launcher.diagnostics.some((diagnostic) => diagnostic.severity === "error") ||
        customAppScannerConfigHash(launcher.config) !== capability.configHash ||
        !workflow ||
        workflow.baseId !== app.baseId ||
        workflow.revision !== capability.revision
      ) {
        continue;
      }
      scanners.set(block.id, {
        endpoint: customAppScannerUrl(app.shortId, page.id, block.id, publicPageParams),
        state: {
          baseId: base.shortId,
          launcherId: launcher.shortId,
          expectedRevision: capability.revision,
          workflowId: workflow.shortId,
          workflowName: workflow.name,
          workflowDescription: workflow.description,
          initialCode: null,
          returnHref: null,
          inputContract: {
            workflow: { id: workflow.id, name: workflow.name, plan: workflow.plan },
            tables: [],
            inputSources: scannerLauncherPromptInputSources(launcher.config),
          },
        },
      });
    }
  }
  return {
    definition: runtimeDefinition,
    page: runtimePage,
    shortId: app.shortId,
    results,
    metrics,
    charts,
    forms,
    commentEndpoints,
    actions,
    rowActions,
    recordEndpoints,
    recordUpdateEndpoints,
    documents,
    pageRecords,
    renderedHtml,
    dateConfig,
    markdownContext: runtimeContext.query,
    scanners,
    sidebarActions,
    signedIn: Boolean(accessActorUser(requestAccess)),
  };
}
