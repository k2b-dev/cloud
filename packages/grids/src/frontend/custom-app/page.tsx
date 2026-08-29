import { MarkdownView, Placeholder, StatCell, StatGrid } from "@k2b/ui";
import { type AuthContext, getDateConfig, getLocale } from "@valentinkolb/cloud/server";
import { Layout } from "@valentinkolb/cloud/ssr";
import { resolvePublishedCustomAppRuntime } from "../../api/custom-app-published-runtime";
import { projectDocuments } from "../../api/documents-api-shared";
import { accessActorUser, actorViewerFor, gridsAccessContext } from "../../api/permissions";
import { ssr } from "../../config";
import type { Field, GridRecord } from "../../contracts";
import { customAppPageRecordFieldIds } from "../../custom-apps/conditions";
import type { CustomAppBlock, CustomAppDefinition, CustomAppPage } from "../../custom-apps/contracts";
import { renderCustomAppMarkdown } from "../../custom-apps/markdown-context";
import { projectCustomAppRecord } from "../../custom-apps/record-projection";
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
} from "../../custom-apps/routing";
import { buildCustomAppRuntimeContext, customAppDefinitionWithAvailableNavigation } from "../../custom-apps/runtime-context";
import { customAppScannerConfigHash } from "../../custom-apps/scanner-capability";
import type { DslQueryContextValues } from "../../query-dsl/parameters";
import { gridsService } from "../../service";
import {
  type CustomAppChartData,
  type CustomAppMetricCell,
  chartDataFromPreview,
  metricCellsFromPreview,
} from "../../service/custom-app-insights";
import { resolvePublishedCustomAppForm } from "../../service/custom-app-published-form";
import {
  buildCustomAppRecordLabelCache,
  customAppRecordRelationSnapshot,
  sameCustomAppRecordRelationSnapshot,
} from "../../service/custom-app-record-relations";
import { executePublishedCustomAppRecords } from "../../service/custom-app-records-query";
import { executePublishedCustomAppQuery, publishedCustomAppAvailability } from "../../service/custom-app-runtime-query";
import type { PublicRenderableForm } from "../../service/forms";
import { ALL_RECORD_ACCESS } from "../../service/record-access";
import { scannerLauncherPromptInputSources } from "../../workflows/contracts";
import type { PublicDocument } from "../_components/documents/public-document-types";
import FormSubmit from "../_components/forms/PublicFormSubmit.island";
import RecordComments from "../_components/records/RecordComments.island";
import type { WorkflowScannerState } from "../_components/workflows/WorkflowScannerSurface";
import Actions, { type CustomAppRenderedAction } from "./Actions.island";
import CustomAppChart from "./Chart";
import { CustomAppPageLayout } from "./PageLayout";
import RecordDetails from "./RecordDetails.island";
import RecordsTable, { type CustomAppRecordsSuccess, type CustomAppRenderedRowAction } from "./RecordsTable.island";
import { RenderedHtml } from "./RenderedHtml";
import { customAppRuntimeMessages, useCustomAppRuntimeMessages } from "./runtime-messages";
import Scanner from "./Scanner.island";
import SidebarActions, { type CustomAppRenderedSidebarAction } from "./SidebarActions.island";
import { formatCustomAppValue } from "./value-format";

type RecordsBlock = Extract<CustomAppBlock, { type: "records" }>;
type ReferencedRecordsBlock = Extract<CustomAppBlock, { type: "referenced_records" }>;
type RecordsLikeBlock = RecordsBlock | ReferencedRecordsBlock;
type MetricsBlock = Extract<CustomAppBlock, { type: "metrics" }>;
type ChartBlock = Extract<CustomAppBlock, { type: "chart" }>;
type InsightBlock = MetricsBlock | ChartBlock;
type RecordBlock = Extract<CustomAppBlock, { type: "record" }>;
type HtmlBlock = Extract<CustomAppBlock, { type: "html" }>;
type FormBlock = Extract<CustomAppBlock, { type: "form" }>;
type CommentsBlock = Extract<CustomAppBlock, { type: "comments" }>;
type ActionsBlock = Extract<CustomAppBlock, { type: "actions" }>;
type ScannerBlock = Extract<CustomAppBlock, { type: "scanner" }>;
type BlockResult = { ok: true; result: CustomAppRecordsSuccess } | { ok: false; message: string };
type MetricsBlockData = { ok: true; cells: CustomAppMetricCell[] } | { ok: false; message: string };
type ChartBlockData = { ok: true; chart: CustomAppChartData } | { ok: false; message: string };
type PageRecord = {
  record: GridRecord;
  fields: Field[];
  relationLabels: Record<string, string>;
  tableName: string;
  auditPolicy: NonNullable<Awaited<ReturnType<typeof gridsService.table.get>>>["auditPolicy"];
  filesByField: Awaited<ReturnType<typeof gridsService.file.listForRecord>>;
  fileEndpoints: Record<string, string>;
};
type FormBlockData =
  | {
      ok: true;
      form: PublicRenderableForm;
      fields: Field[];
      inlineTargetFields: Record<string, Field[]>;
      submitUrl: string;
    }
  | { ok: false; message: string };
type CustomAppDocument = PublicDocument & { downloadUrl: string };
type ResolvedPublishedForm = NonNullable<Awaited<ReturnType<typeof resolvePublishedCustomAppForm>>>;

const preparePublishedForm = (
  resolved: ResolvedPublishedForm,
  fixedFieldIds: readonly string[],
): Omit<Extract<FormBlockData, { ok: true }>, "submitUrl"> | null => {
  const fixed = new Set(fixedFieldIds);
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
  return { ok: true, form: renderable, fields, inlineTargetFields };
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

const Records = (props: {
  block: RecordsLikeBlock;
  data: BlockResult;
  baseId: string;
  dateConfig: ReturnType<typeof getDateConfig>;
  shortId: string;
  endpoint: string;
  rowActions: CustomAppRenderedRowAction[];
}) => {
  const messages = useCustomAppRuntimeMessages();
  if (!props.data.ok) {
    return (
      <Placeholder
        variant="compact"
        align="left"
        title={messages().recordsBlockUnavailable({ title: props.block.title ?? messages().records })}
        description={props.data.message}
      />
    );
  }
  return (
    <RecordsTable
      title={props.block.title ?? messages().records}
      emptyText={props.block.emptyText ?? messages().noRecords}
      baseId={props.baseId}
      dateConfig={props.dateConfig}
      appId={props.shortId}
      selectedColumnIds={
        props.block.type === "records" && props.block.display.kind === "table" && props.block.display.columnIds.length > 0
          ? props.block.display.columnIds
          : undefined
      }
      result={props.data.result}
      endpoint={props.endpoint}
      searchable={props.block.searchable}
      rowNavigate={props.block.type === "records" ? props.block.rowNavigate : undefined}
      rowActions={props.rowActions}
    />
  );
};

const Metrics = (props: { data: MetricsBlockData; dateConfig: ReturnType<typeof getDateConfig> }) => {
  const messages = useCustomAppRuntimeMessages();
  if (!props.data.ok) {
    return <Placeholder variant="compact" align="left" title={messages().metricsUnavailable} description={props.data.message} />;
  }
  if (props.data.cells.length === 0) return <Placeholder variant="compact" align="left" description={messages().noMetrics} />;
  return (
    <StatGrid columns={props.data.cells.length === 1 ? 1 : props.data.cells.length === 2 ? 2 : 3}>
      {props.data.cells.map((cell) => {
        const value = formatCustomAppValue(cell.value, cell.valueFormat, props.dateConfig);
        return <StatCell label={cell.label} value={value} title={value} />;
      })}
    </StatGrid>
  );
};

const AppChart = (props: { block: ChartBlock; data: ChartBlockData; dateConfig: ReturnType<typeof getDateConfig> }) => {
  const messages = useCustomAppRuntimeMessages();
  if (!props.data.ok) {
    return <Placeholder variant="compact" align="left" title={messages().chartUnavailable} description={props.data.message} />;
  }
  return (
    <div class="flex h-72 min-h-0 flex-col">
      {props.block.subtitle ? <p class="mb-3 text-sm text-secondary">{props.block.subtitle}</p> : null}
      <CustomAppChart
        chartType={props.block.chartType}
        data={props.data.chart}
        valueFormat={props.block.valueFormat}
        dateConfig={props.dateConfig}
      />
    </div>
  );
};

const Record = (props: {
  block: RecordBlock;
  pageRecord: PageRecord | null;
  baseId: string;
  updateEndpoint?: string;
  documents: CustomAppDocument[];
  dateConfig: ReturnType<typeof getDateConfig>;
}) => {
  const messages = useCustomAppRuntimeMessages();
  if (!props.pageRecord) {
    return (
      <Placeholder
        variant="compact"
        align="left"
        title={props.block.title ?? messages().record}
        description={props.block.emptyText ?? messages().recordNotFound}
      />
    );
  }
  return (
    <RecordDetails
      block={props.block}
      baseId={props.baseId}
      tableName={props.pageRecord.tableName}
      auditPolicy={props.pageRecord.auditPolicy}
      record={props.pageRecord.record}
      fields={props.pageRecord.fields}
      relationLabels={props.pageRecord.relationLabels}
      updateEndpoint={props.updateEndpoint}
      fileEndpoints={props.pageRecord.fileEndpoints}
      filesByField={props.pageRecord.filesByField}
      documents={props.documents}
      dateConfig={props.dateConfig}
    />
  );
};

const Form = (props: { block: FormBlock; data: FormBlockData; dateConfig: ReturnType<typeof getDateConfig> }) => {
  const messages = useCustomAppRuntimeMessages();
  if (!props.data.ok) {
    return <Placeholder variant="compact" align="left" title={messages().formUnavailable} description={props.data.message} />;
  }
  return (
    <FormSubmit
      submitUrl={props.data.submitUrl}
      form={props.data.form}
      fields={props.data.fields}
      inlineTargetFields={props.data.inlineTargetFields}
      dateConfig={props.dateConfig}
      surface="bare"
      showTitle={!props.block.title}
      titleAs="h2"
    />
  );
};

const CustomAppPage = (props: {
  definition: CustomAppDefinition;
  page: CustomAppPage;
  shortId: string;
  results: Map<string, BlockResult>;
  metrics: Map<string, MetricsBlockData>;
  charts: Map<string, ChartBlockData>;
  forms: Map<string, FormBlockData>;
  commentEndpoints: Map<string, string>;
  actions: Map<string, CustomAppRenderedAction[]>;
  rowActions: Map<string, CustomAppRenderedRowAction[]>;
  recordEndpoints: Map<string, string>;
  recordUpdateEndpoints: Map<string, string>;
  documents: Map<string, CustomAppDocument[]>;
  pageRecords: Map<string, PageRecord>;
  renderedHtml: Map<string, { html: unknown; fieldName: string }>;
  dateConfig: ReturnType<typeof getDateConfig>;
  markdownContext: DslQueryContextValues;
  scanners: Map<string, { state: WorkflowScannerState; endpoint: string }>;
  sidebarActions: CustomAppRenderedSidebarAction[];
  signedIn: boolean;
}) => {
  const messages = useCustomAppRuntimeMessages();
  return (
    <CustomAppPageLayout
      definition={props.definition}
      page={props.page}
      appId={props.shortId}
      hasSidebarActions={props.sidebarActions.length > 0}
      sidebarActions={<SidebarActions actions={props.sidebarActions} />}
      renderBlock={(block) =>
        block.type === "markdown" ? (
          <MarkdownView markdown={renderCustomAppMarkdown(block.markdown, props.markdownContext)} headingScale="large" />
        ) : block.type === "records" || block.type === "referenced_records" ? (
          <Records
            block={block}
            data={props.results.get(block.id) ?? { ok: false, message: messages().recordsAreUnavailable }}
            baseId={props.definition.baseId}
            dateConfig={props.dateConfig}
            shortId={props.shortId}
            endpoint={props.recordEndpoints.get(block.id) ?? ""}
            rowActions={props.rowActions.get(block.id) ?? []}
          />
        ) : block.type === "metrics" ? (
          <Metrics
            data={props.metrics.get(block.id) ?? { ok: false, message: messages().metricsAreUnavailable }}
            dateConfig={props.dateConfig}
          />
        ) : block.type === "chart" ? (
          <AppChart
            block={block}
            data={props.charts.get(block.id) ?? { ok: false, message: messages().chartDataUnavailable }}
            dateConfig={props.dateConfig}
          />
        ) : block.type === "record" ? (
          <Record
            block={block}
            pageRecord={props.pageRecords.get(block.id) ?? null}
            baseId={props.definition.baseId}
            updateEndpoint={props.recordUpdateEndpoints.get(block.id)}
            documents={props.documents.get(block.id) ?? []}
            dateConfig={props.dateConfig}
          />
        ) : block.type === "html" ? (
          <RenderedHtml
            html={props.renderedHtml.get(block.id)?.html}
            title={block.title ?? props.renderedHtml.get(block.id)?.fieldName ?? messages().renderedHtml}
            height={block.height}
          />
        ) : block.type === "comments" ? (
          <RecordComments endpoint={props.commentEndpoints.get(block.id) ?? ""} title={block.title} dateConfig={props.dateConfig} />
        ) : block.type === "actions" ? (
          <Actions actions={props.actions.get(block.id) ?? []} />
        ) : block.type === "form" ? (
          <Form
            block={block}
            data={props.forms.get(block.id) ?? { ok: false, message: messages().thisFormUnavailable }}
            dateConfig={props.dateConfig}
          />
        ) : props.scanners.has(block.id) ? (
          <Scanner {...props.scanners.get(block.id)!} />
        ) : (
          <Placeholder
            variant="compact"
            align="left"
            title={props.signedIn ? messages().scannerUnavailable : messages().signInToScan}
            description={props.signedIn ? messages().scannerChanged : undefined}
          />
        )
      }
    />
  );
};

export default ssr<AuthContext>(async (c) => {
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
  if (!runtime) return c.notFound();
  const { app, definition, capabilities, base, page, pageParams, dateConfig, runtimeContext, authSubjectIds, viewer } = runtime;
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
  for (const [parameterId, parameter] of Object.entries(page.parameters)) {
    const record = await gridsService.record.get(parameter.tableId, pageParams[parameterId]!, {
      viewer,
      recordAccess: ALL_RECORD_ACCESS,
      dateConfig,
    });
    if (!record) return c.notFound();
    parameterRecords.set(parameterId, record);
  }

  let pageRecord: PageRecord | null = null;
  const pageRecords = new Map<string, PageRecord>();
  const renderedHtml = new Map<string, { html: unknown; fieldName: string }>();
  const recordUpdateEndpoints = new Map<string, string>();
  const documents = new Map<string, CustomAppDocument[]>();
  if (page.record) {
    const capability = capabilities.records.find((candidate) => candidate.pageId === page.id && candidate.tableId === page.record!.tableId);
    const expectedFieldIds = customAppPageRecordFieldIds(page);
    const expectedEditableFieldIds = [
      ...new Set(
        page.rows.flatMap((row) =>
          row.columns.flatMap((column) => column.blocks.flatMap((block) => (block.type === "record" ? block.editableFieldIds : []))),
        ),
      ),
    ].sort();
    if (
      !capability ||
      capability.fieldIds.join("\0") !== expectedFieldIds.join("\0") ||
      capability.editableFieldIds.join("\0") !== expectedEditableFieldIds.join("\0")
    ) {
      return c.notFound();
    }
    const record = parameterRecords.get(page.record.id.path);
    if (!record) return c.notFound();
    const allowed = new Set(capability.fieldIds);
    const fields = (await gridsService.field.listByTable(page.record.tableId)).filter((field) => allowed.has(field.id));
    if (fields.length !== allowed.size) return c.notFound();
    const table = await gridsService.table.get(page.record.tableId);
    if (!table) return c.notFound();
    const relationTargetTableIds = [...new Set(capability.relationLabels.map((relation) => relation.targetTableId))];
    const relationTargetTables = await Promise.all(relationTargetTableIds.map((tableId) => gridsService.table.get(tableId)));
    if (relationTargetTables.some((target) => !target || target.baseId !== app.baseId)) return c.notFound();
    const targetFieldsByTableId = await gridsService.field.listByTables(relationTargetTableIds);
    const liveRelationLabels = customAppRecordRelationSnapshot(fields, targetFieldsByTableId);
    if (!sameCustomAppRecordRelationSnapshot(capability.relationLabels, liveRelationLabels)) return c.notFound();
    const relationTableIds = [page.record.tableId, ...relationTargetTableIds];
    const relationViewer = {
      ...actorViewerFor(requestAccess),
      isAdmin: false,
      readableTableIds: new Set(relationTableIds),
      recordAccessByTableId: new Map(relationTableIds.map((tableId) => [tableId, ALL_RECORD_ACCESS])),
    };
    const fileFieldIds = fields.filter((field) => field.type === "file").map((field) => field.id);
    const filesByField = await gridsService.file.listForRecord({
      tableId: page.record.tableId,
      recordId: record.id,
      fieldIds: fileFieldIds,
    });
    pageRecord = {
      record,
      fields,
      relationLabels: {},
      tableName: table.name,
      auditPolicy: table.auditPolicy,
      filesByField,
      fileEndpoints: {},
    };
    const visibleHtmlBlocks = runtimePage.rows.flatMap((row) =>
      row.columns.flatMap((column) => column.blocks.filter((candidate): candidate is HtmlBlock => candidate.type === "html")),
    );
    const fieldsById = new Map(fields.map((field) => [field.id, field]));
    for (const block of visibleHtmlBlocks) {
      const field = fieldsById.get(block.fieldId);
      if (!field || field.type !== "html_template") return c.notFound();
      renderedHtml.set(block.id, { html: record.data[field.id], fieldName: field.name });
    }
    const visibleRecordBlocks = runtimePage.rows.flatMap((row) =>
      row.columns.flatMap((column) => column.blocks.filter((candidate): candidate is RecordBlock => candidate.type === "record")),
    );
    for (const block of visibleRecordBlocks) {
      const blockFieldIds = new Set(block.fieldIds);
      const blockFields = fields.filter((field) => blockFieldIds.has(field.id));
      const blockRecord = projectCustomAppRecord(record, block.fieldIds);
      const blockRelations = capability.relationLabels.filter((relation) => blockFieldIds.has(relation.fieldId));
      const relationLabels = await buildCustomAppRecordLabelCache({
        records: [blockRecord],
        fields: blockFields,
        relations: blockRelations,
        viewer: relationViewer,
        actorUserId: accessActorUser(requestAccess)?.id ?? null,
      });
      pageRecords.set(block.id, {
        record: blockRecord,
        fields: blockFields,
        relationLabels,
        tableName: table.name,
        auditPolicy: table.auditPolicy,
        filesByField: Object.fromEntries(
          blockFields.filter((field) => field.type === "file").map((field) => [field.id, filesByField[field.id] ?? []]),
        ),
        fileEndpoints: Object.fromEntries(
          blockFields
            .filter((field) => field.type === "file")
            .map((field) => [field.id, customAppRecordFilesUrl(app.shortId, page.id, block.id, field.id, pageParams)]),
        ),
      });
    }

    if (expectedEditableFieldIds.length > 0 && accessActorUser(requestAccess)) {
      for (const block of runtimePage.rows.flatMap((row) =>
        row.columns.flatMap((column) => column.blocks.filter((candidate): candidate is RecordBlock => candidate.type === "record")),
      )) {
        if (block.editableFieldIds.length > 0) {
          recordUpdateEndpoints.set(block.id, customAppRecordUpdateUrl(app.shortId, page.id, block.id, pageParams));
        }
      }
    }

    const documentBlocks = runtimePage.rows.flatMap((row) =>
      row.columns.flatMap((column) =>
        column.blocks.filter((candidate): candidate is RecordBlock => candidate.type === "record" && Boolean(candidate.documents)),
      ),
    );
    const configuredTemplateIds = new Set<string>();
    for (const block of documentBlocks) {
      const expectedTemplateIds = [...(block.documents?.templateIds ?? [])].sort();
      const capability = capabilities.documents.find(
        (candidate) => candidate.pageId === page.id && candidate.blockId === block.id && candidate.tableId === page.record!.tableId,
      );
      if (!capability || capability.templateIds.join("\0") !== expectedTemplateIds.join("\0")) return c.notFound();
      for (const templateId of expectedTemplateIds) configuredTemplateIds.add(templateId);
    }
    const readableTemplateIds: string[] = [];
    for (const templateId of configuredTemplateIds) {
      const template = await gridsService.document.getTemplate(templateId);
      if (!template || template.tableId !== page.record.tableId) continue;
      readableTemplateIds.push(templateId);
    }
    const documentSummaries = await gridsService.document.listDocumentSummariesForRecordByTemplates(
      page.record.tableId,
      record.id,
      readableTemplateIds,
    );
    const projectedDocuments = await projectDocuments(documentSummaries);
    for (const block of documentBlocks) {
      const allowed = new Set(block.documents?.templateIds ?? []);
      documents.set(
        block.id,
        documentSummaries.flatMap((documentSummary, index) => {
          const document = projectedDocuments[index];
          return document && allowed.has(documentSummary.templateId)
            ? [
                {
                  ...document,
                  downloadUrl: customAppDocumentDownloadUrl(app.shortId, page.id, block.id, documentSummary.id, pageParams),
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
        return [
          block.id,
          {
            ok: true,
            result: {
              ...published.response,
              ...(published.presentation ? { presentation: published.presentation } : {}),
              ...(published.cards ? { cards: published.cards } : {}),
              ...(published.rowNavigationParams ? { rowNavigationParams: published.rowNavigationParams } : {}),
            },
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
      const capability = capabilities.insights.find(
        (candidate) =>
          candidate.pageId === page.id &&
          candidate.blockId === block.id &&
          candidate.blockType === block.type &&
          candidate.source.kind === source.kind &&
          (candidate.source.kind !== "view" || (source.kind === "view" && candidate.source.viewId === source.viewId)),
      );
      if (!capability) return [block.id, { ok: false, message: t.dataSourceNotPublished }];
      const maxRows = block.type === "metrics" ? 1 : block.limit;
      try {
        const view = source.kind === "view" ? await gridsService.view.get(source.viewId) : null;
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
        const sourceFields = outputTableIds.flatMap((tableId) => fieldGroups.get(tableId) ?? []);
        if (block.type === "metrics") return [block.id, { ok: true, cells: metricCellsFromPreview(response, sourceFields) }];
        const chart = chartDataFromPreview(response, sourceFields);
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
      (candidate) => candidate.pageId === page.id && candidate.blockId === block.id && candidate.tableId === page.record?.tableId,
    );
    if (!capability || !page.record || !pageRecord) return c.notFound();
    commentEndpoints.set(block.id, customAppCommentsUrl(app.shortId, page.id, block.id, pageParams));
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
      const prepared = preparePublishedForm(resolvedForm, Object.keys(block.fixedValues));
      if (!prepared) {
        return [block.id, { ok: false, message: t.formChanged }];
      }
      return [
        block.id,
        {
          ...prepared,
          submitUrl: customAppFormSubmitUrl(app.shortId, page.id, block.id, pageParams),
        },
      ];
    }),
  );
  const forms = new Map(formEntries);
  const sidebarActions: CustomAppRenderedSidebarAction[] = [];
  for (const action of availableSidebarActions) {
    const resolvedForm = await resolvePublishedCustomAppForm({ surface: action, capabilities });
    if (!resolvedForm) continue;
    const prepared = preparePublishedForm(resolvedForm, Object.keys(action.fixedValues));
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
        const href = customAppActionHref(app.shortId, action, pageParams, pageRecord?.record.id);
        if (href) rendered.push({ id: action.id, kind: "navigate", label: action.label, icon: action.icon, href, history: action.history });
        continue;
      }
      if (!accessActorUser(requestAccess)) continue;
      const capability = capabilities.workflowLaunchers.find(
        (candidate) =>
          "pageId" in candidate &&
          candidate.pageId === page.id &&
          candidate.blockId === block.id &&
          candidate.actionId === action.id &&
          candidate.launcherId === action.launcherId,
      );
      if (capability) {
        rendered.push({
          id: action.id,
          kind: "workflow",
          label: action.label,
          icon: action.icon,
          endpoint: customAppActionUrl(app.shortId, page.id, block.id, action.id, pageParams),
          confirm: action.confirm,
        });
      }
    }
    actions.set(block.id, rendered);
  }
  const rowActions = new Map<string, CustomAppRenderedRowAction[]>();
  const recordEndpoints = new Map<string, string>();
  for (const block of blocks) {
    recordEndpoints.set(block.id, customAppRecordsUrl(app.shortId, page.id, block.id, pageParams));
    const rendered: CustomAppRenderedRowAction[] = [];
    if (accessActorUser(requestAccess)) {
      for (const action of block.rowActions ?? []) {
        if (!(await available("action", action.availableWhen?.query, block.id, action.id))) continue;
        const capability = capabilities.workflowLaunchers.find(
          (candidate) =>
            "pageId" in candidate &&
            candidate.pageId === page.id &&
            candidate.blockId === block.id &&
            candidate.actionId === action.id &&
            candidate.launcherId === action.launcherId,
        );
        if (!capability) continue;
        rendered.push({
          id: action.id,
          label: action.label,
          icon: action.icon,
          showLabel: action.showLabel,
          endpoint: customAppRowActionUrl(app.shortId, page.id, block.id, action.id, pageParams),
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
      const capability = capabilities.scannerLaunchers.find(
        (candidate) => candidate.pageId === page.id && candidate.blockId === block.id && candidate.launcherId === block.launcherId,
      );
      if (!capability) continue;
      const [launcher, workflow] = await Promise.all([
        gridsService.workflow.launcher.get(block.launcherId),
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
        endpoint: customAppScannerUrl(app.shortId, page.id, block.id, pageParams),
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
  return () => (
    <Layout c={c} fullWidth fullPage title={[{ title: definition.name, href: `/apps/${app.shortId}` }, { title: page.title }]}>
      <CustomAppPage
        definition={runtimeDefinition}
        page={runtimePage}
        shortId={app.shortId}
        results={results}
        metrics={metrics}
        charts={charts}
        forms={forms}
        commentEndpoints={commentEndpoints}
        actions={actions}
        rowActions={rowActions}
        recordEndpoints={recordEndpoints}
        recordUpdateEndpoints={recordUpdateEndpoints}
        documents={documents}
        pageRecords={pageRecords}
        renderedHtml={renderedHtml}
        dateConfig={dateConfig}
        markdownContext={runtimeContext.query}
        scanners={scanners}
        sidebarActions={sidebarActions}
        signedIn={Boolean(accessActorUser(requestAccess))}
      />
    </Layout>
  );
});
