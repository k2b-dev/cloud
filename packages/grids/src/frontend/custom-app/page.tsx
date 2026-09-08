import { MarkdownView, Placeholder, StatCell, StatGrid } from "@k2b/ui";
import type { AuthContext, getDateConfig } from "@valentinkolb/cloud/server";
import { Layout } from "@valentinkolb/cloud/ssr";
import {
  type BlockResult,
  type ChartBlock,
  type ChartBlockData,
  type CustomAppDocument,
  type FormBlock,
  type FormBlockData,
  loadPublishedCustomAppPage,
  type MetricsBlockData,
  type PageRecord,
  type RecordBlock,
  type RecordsLikeBlock,
} from "../../api/custom-app-published-page";
import { ssr } from "../../config";
import type { CustomAppDefinition, CustomAppPage } from "../../custom-apps/contracts";
import { renderCustomAppMarkdown } from "../../custom-apps/markdown-context";
import type { DslQueryContextValues } from "../../query-dsl/parameters";
import FormSubmit from "../_components/forms/PublicFormSubmit.island";
import RecordComments from "../_components/records/RecordComments.island";
import type { WorkflowScannerState } from "../_components/workflows/WorkflowScannerSurface";
import Actions, { type CustomAppRenderedAction } from "./Actions.island";
import CustomAppChart from "./Chart";
import { CustomAppPageLayout } from "./PageLayout";
import RecordDetails from "./RecordDetails.island";
import RecordsTable, { type CustomAppRenderedRowAction } from "./RecordsTable.island";
import { RenderedHtml } from "./RenderedHtml";
import { useCustomAppRuntimeMessages } from "./runtime-messages";
import Scanner from "./Scanner.island";
import SidebarActions, { type CustomAppRenderedSidebarAction } from "./SidebarActions.island";
import { formatCustomAppValue } from "./value-format";

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
          <RecordComments
            endpoint={props.commentEndpoints.get(block.id) ?? ""}
            title={block.title}
            dateConfig={props.dateConfig}
            cursorParameter="_cursor"
          />
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
  const data = await loadPublishedCustomAppPage(c);
  if (!data) return ssr.error(c, 404, { layout: "minimal" });
  return () => (
    <Layout c={c} fullWidth fullPage title={[{ title: data.definition.name, href: `/apps/${data.shortId}` }, { title: data.page.title }]}>
      <CustomAppPage {...data} />
    </Layout>
  );
});
