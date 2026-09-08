import type { DateContext } from "@k2b/stdlib";
import { Button, MarkdownView, Placeholder, StatCell, StatGrid } from "@k2b/ui";
import { createEffect, createMemo, createResource, For, Show } from "solid-js";
import { apiClient } from "../../../api/client";
import type { PublicDslQueryPreviewResponse as DslQueryPreviewResponse } from "../../../api/gql-public";
import type { PublicForm as Form } from "../../../api/public-dto";
import type { RecordDisplayConfig } from "../../../contracts";
import type { CustomAppBlock } from "../../../custom-apps/contracts";
import { chartDataFromPreview, metricCellsFromPreview } from "../../../service/custom-app-insights";
import CustomAppChart from "../../custom-app/Chart";
import RecordsTable from "../../custom-app/RecordsTable.island";
import { formatCustomAppValue } from "../../custom-app/value-format";
import FormSubmit from "../forms/PublicFormSubmit.island";
import { errorMessage } from "../utils/api-helpers";
import { useCustomAppBuilderMessages } from "./builder-messages";
import type { CustomAppCatalog } from "./custom-app-catalog";

type SourceBlock = Extract<CustomAppBlock, { type: "records" | "metrics" | "chart" }>;

const loadSource = async (baseId: string, block: SourceBlock): Promise<DslQueryPreviewResponse> => {
  const response =
    block.source.kind === "view"
      ? await apiClient.gql["by-base"][":baseId"].views[":viewId"].execute.$post({
          param: { baseId, viewId: block.source.viewId },
          json: { pageSize: block.type === "chart" ? block.limit : 100, surface: "custom-app" },
        })
      : await apiClient.gql["by-base"][":baseId"].execute.$post({
          param: { baseId },
          json: {
            query: block.source.query,
            pageSize: block.type === "records" ? block.pageSize : block.type === "metrics" ? 1 : block.limit,
            limit: block.type === "records" ? block.pageSize : block.type === "metrics" ? 1 : block.limit,
            surface: "custom-app",
          },
        });
  if (!response.ok) throw new Error(await errorMessage(response, "Could not load the data preview."));
  return response.json();
};

const renderableForm = (form: Form & { id: string }, fixedFieldIds: string[]) => ({
  id: form.id,
  name: form.name,
  config: {
    ...form.config,
    redirectUrl: null,
    fields: form.config.fields.filter((entry) => entry.kind === "user_input" && !fixedFieldIds.includes(entry.fieldId)),
  },
});

function SourcePreview(props: {
  baseId: string;
  appId: string;
  block: SourceBlock;
  catalog: CustomAppCatalog;
  dateConfig?: DateContext;
  initialResult?: DslQueryPreviewResponse;
  onPreviewResult?: (blockId: string, result: DslQueryPreviewResponse) => void;
}) {
  const messages = useCustomAppBuilderMessages();
  const text = messages().text;
  const initialSource = JSON.stringify([props.baseId, props.block.source]);
  const source = () => JSON.stringify([props.baseId, props.block.source]);
  const [preview, { refetch }] = createResource(
    () => (props.initialResult && source() === initialSource ? false : source()),
    () => loadSource(props.baseId, props.block),
    { initialValue: props.initialResult },
  );
  const previewResult = () => (preview.error ? undefined : preview());
  const sourceFields = () => {
    const result = previewResult();
    const tableIds = new Set((result?.ok ? result.columns : []).flatMap((column) => (column.tableId ? [column.tableId] : [])));
    return [...tableIds].flatMap((tableId) => props.catalog.fieldsByTable[tableId] ?? []);
  };
  const cardDisplayConfig = (): RecordDisplayConfig | null => {
    if (props.block.type !== "records" || props.block.display.kind !== "cards" || props.block.source.kind !== "view") return null;
    const viewId = props.block.source.viewId;
    const view = Object.values(props.catalog.viewsByTable)
      .flat()
      .find((candidate) => candidate.id === viewId);
    return view?.ui.displayConfig?.mode === "cards" ? view.ui.displayConfig : null;
  };
  createEffect(() => {
    const result = previewResult();
    if (result) props.onPreviewResult?.(props.block.id, result);
  });
  return (
    <Show
      when={!preview.loading}
      fallback={
        <Placeholder
          state="loading"
          align="left"
          title={text({ value: "Loading preview" })}
          description={text({ value: "Running this block's data source." })}
        />
      }
    >
      <Show
        when={previewResult()}
        fallback={
          <Placeholder
            state={preview.error ? "error" : "empty"}
            align="left"
            title={text({ value: "Records unavailable" })}
            description={text({ value: "The preview could not be loaded." })}
            action={
              <Show when={preview.error}>
                <Button type="button" size="sm" variant="secondary" onClick={() => refetch()}>
                  {text({ value: "Reload preview" })}
                </Button>
              </Show>
            }
          />
        }
      >
        {(result) => {
          const resolved = result();
          if (!resolved.ok)
            return (
              <Placeholder
                align="left"
                title={text({ value: "Data unavailable" })}
                description={resolved.diagnostics[0]?.message ?? text({ value: "The data source could not be previewed." })}
              />
            );
          return props.block.type === "records" ? (
            <RecordsTable
              title={props.block.title ?? text({ value: "Records" })}
              emptyText={props.block.emptyText ?? text({ value: "No records found." })}
              baseId={props.baseId}
              dateConfig={props.dateConfig}
              appId={props.appId}
              selectedColumnIds={
                props.block.display.kind === "table" && props.block.display.columnIds.length > 0 ? props.block.display.columnIds : undefined
              }
              result={
                cardDisplayConfig()
                  ? {
                      ...resolved,
                      cards: {
                        displayConfig: cardDisplayConfig()!,
                        fields: sourceFields(),
                        relationLabels: {},
                        filePreviews: {},
                      },
                    }
                  : resolved
              }
              rowNavigate={props.block.rowNavigate}
              rowActions={(props.block.rowActions ?? []).map((action) => ({
                id: action.id,
                label: action.label,
                icon: action.icon,
                showLabel: action.showLabel,
                endpoint: "",
              }))}
              preview
            />
          ) : props.block.type === "metrics" ? (
            <StatGrid columns={3}>
              <For each={metricCellsFromPreview(resolved, sourceFields())}>
                {(cell) => {
                  const value = formatCustomAppValue(cell.value, cell.valueFormat, props.dateConfig);
                  return <StatCell label={cell.label} value={value} title={value} />;
                }}
              </For>
            </StatGrid>
          ) : props.dateConfig ? (
            <CustomAppChart
              chartType={props.block.chartType}
              data={chartDataFromPreview(resolved, sourceFields())}
              valueFormat={props.block.valueFormat}
              dateConfig={props.dateConfig}
            />
          ) : (
            <Placeholder
              align="left"
              title={text({ value: "Chart preview unavailable" })}
              description={text({ value: "Date formatting context is missing." })}
            />
          );
        }}
      </Show>
    </Show>
  );
}

export default function CustomAppBlockPreview(props: {
  block: CustomAppBlock;
  baseId: string;
  appId: string;
  catalog: CustomAppCatalog;
  markdownInlineTokens?: readonly string[];
  dateConfig?: DateContext;
  initialResult?: DslQueryPreviewResponse;
  onPreviewResult?: (blockId: string, result: DslQueryPreviewResponse) => void;
}) {
  const messages = useCustomAppBuilderMessages();
  const text = messages().text;
  const form = createMemo(() => {
    const block = props.block;
    if (block.type !== "form") return null;
    return (
      Object.values(props.catalog.formsByTable)
        .flat()
        .find(
          (candidate): candidate is Form & { id: string } =>
            candidate.id === block.formId && candidate.deletedAt === null && candidate.isActive,
        ) ?? null
    );
  });
  const formFields = createMemo(() => {
    const selected = form();
    if (!selected) return [];
    const visible = new Set(selected.config.fields.map((entry) => entry.fieldId));
    return (props.catalog.fieldsByTable[selected.tableId] ?? []).filter((field) => visible.has(field.id) && field.deletedAt === null);
  });

  return props.block.type === "markdown" ? (
    <Show
      when={props.block.markdown.trim()}
      fallback={
        <Placeholder
          state="empty"
          variant="compact"
          align="left"
          title={text({ value: "Empty Markdown block" })}
          description={text({ value: "Select this block to add text or context placeholders." })}
        />
      }
    >
      <MarkdownView markdown={props.block.markdown} inlineTokens={props.markdownInlineTokens} headingScale="large" />
    </Show>
  ) : props.block.type === "referenced_records" ? (
    <Placeholder
      state="empty"
      variant="compact"
      align="left"
      title={props.block.title ?? text({ value: "Referenced records" })}
      description={text({ value: "This block is loaded from the current record when the published app page opens." })}
    />
  ) : props.block.type === "records" || props.block.type === "metrics" || props.block.type === "chart" ? (
    <SourcePreview
      baseId={props.baseId}
      appId={props.appId}
      block={props.block}
      catalog={props.catalog}
      dateConfig={props.dateConfig}
      initialResult={props.initialResult}
      onPreviewResult={props.onPreviewResult}
    />
  ) : props.block.type === "form" ? (
    <Show
      when={form()}
      fallback={
        <Placeholder
          align="left"
          title={text({ value: "Form unavailable" })}
          description={text({ value: "Choose an active Form in this Base." })}
        />
      }
    >
      {(selected) => (
        <FormSubmit
          preview
          form={renderableForm(selected(), Object.keys(props.block.type === "form" ? props.block.fixedValues : {}))}
          fields={formFields()}
          dateConfig={props.dateConfig}
          surface="bare"
          showTitle={!props.block.title}
          titleAs="h2"
        />
      )}
    </Show>
  ) : props.block.type === "actions" ? (
    <div class="flex flex-wrap items-center gap-2">
      <For each={props.block.actions}>
        {(action) => (
          <Button type="button" size="sm" variant={action.kind === "workflow" ? "primary" : "secondary"} disabled>
            <Show when={action.icon}>{(icon) => <i class={`ti ti-${icon()}`} aria-hidden="true" />}</Show>
            {action.label}
          </Button>
        )}
      </For>
    </div>
  ) : props.block.type === "scanner" ? (
    <Placeholder
      align="left"
      icon="ti ti-scan"
      title={props.block.title ? undefined : text({ value: "Scanner" })}
      description={text({ value: "Signed-in readers can scan codes here. Open the published app to use the camera." })}
    />
  ) : props.block.type === "html" ? (
    <Placeholder
      align="left"
      icon="ti ti-code"
      title={props.block.title ? undefined : text({ value: "Rendered HTML" })}
      description={text({ value: "The selected HTML template renders here for the record in the published app." })}
    />
  ) : (
    <Placeholder
      align="left"
      title={`${props.block.type[0]?.toUpperCase()}${props.block.type.slice(1)}`}
      description={text({ value: "Preview data is unavailable for the current page context." })}
    />
  );
}
