import type { DateContext } from "@k2b/stdlib";
import { Button, DataTable, type DataTableColumn, IconButton, Placeholder, prompts, TextInput, toast } from "@k2b/ui";
import { createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import type { PublicField, PublicGridRecord } from "../../api/public-dto";
import type { DslQueryPreviewResponse, RecordDisplayConfig } from "../../contracts";
import type { CustomAppRowNavigation } from "../../custom-apps/contracts";
import { customAppRowHref } from "../../custom-apps/routing";
import type { GridFilePreview } from "../../service";
import { RecordCardsView } from "../_components/records-view/RecordCardsView";
import { FieldValue } from "../_components/table/FieldValue";
import { customAppCardFileUrl } from "./records-card-url";
import { customAppRecordsResultColumns } from "./records-table-model";
import { useCustomAppRuntimeMessages } from "./runtime-messages";
import { invokeCustomAppWorkflow } from "./workflow-action-client";

type QuerySuccess = Extract<DslQueryPreviewResponse, { ok: true }>;
export type CustomAppRecordsSuccess = QuerySuccess & {
  presentation?: { fields: PublicField[] };
  rowNavigationParams?: Record<string, Record<string, string>>;
  cards?: {
    displayConfig: RecordDisplayConfig;
    fields: PublicField[];
    records?: PublicGridRecord[];
    relationLabels: Record<string, string>;
    filePreviews: Record<string, Record<string, GridFilePreview & { contentToken: string }>>;
  };
};

export type CustomAppRenderedRowAction = {
  id: string;
  label: string;
  icon?: string;
  showLabel: boolean;
  endpoint: string;
  confirm?: string;
};
const displayValue = (value: unknown): string => {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(displayValue).join(", ");
  return JSON.stringify(value);
};

const resultFromResponse = async (response: Response, fallback: string): Promise<CustomAppRecordsSuccess> => {
  const body = (await response.json().catch(() => null)) as CustomAppRecordsSuccess | DslQueryPreviewResponse | null;
  if (!response.ok || !body || !("ok" in body) || !body.ok) {
    throw new Error(fallback);
  }
  return body as CustomAppRecordsSuccess;
};

export default function RecordsTable(props: {
  title: string;
  emptyText: string;
  baseId: string;
  dateConfig?: DateContext;
  appId: string;
  endpoint?: string;
  searchable?: boolean;
  selectedColumnIds?: string[];
  result: CustomAppRecordsSuccess;
  rowNavigate?: CustomAppRowNavigation;
  rowActions?: CustomAppRenderedRowAction[];
  preview?: boolean;
}) {
  const messages = useCustomAppRuntimeMessages();
  const [result, setResult] = createSignal(props.result);
  const [query, setQuery] = createSignal("");
  const [appliedQuery, setAppliedQuery] = createSignal("");
  const [cursor, setCursor] = createSignal<string | null>(null);
  const [history, setHistory] = createSignal<Array<string | null>>([]);
  const [loading, setLoading] = createSignal(false);
  const [pendingKey, setPendingKey] = createSignal<string | null>(null);
  let queryTimer: number | null = null;
  let requestController: AbortController | null = null;
  let workflowController: AbortController | null = null;

  onCleanup(() => {
    if (queryTimer !== null) window.clearTimeout(queryTimer);
    requestController?.abort();
    workflowController?.abort();
  });

  const loadPage = async (nextCursor: string | null, nextQuery: string, nextHistory: Array<string | null>) => {
    if (props.preview || !props.endpoint) return;
    requestController?.abort();
    const controller = new AbortController();
    requestController = controller;
    setLoading(true);
    try {
      const url = new URL(props.endpoint, window.location.origin);
      if (nextQuery) url.searchParams.set("_search", nextQuery);
      if (nextCursor) url.searchParams.set("_cursor", nextCursor);
      const response = await fetch(`${url.pathname}${url.search}`, {
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });
      const next = await resultFromResponse(response, messages().recordsLoadFailed);
      if (controller.signal.aborted) return;
      setResult(next);
      setAppliedQuery(nextQuery);
      setCursor(nextCursor);
      setHistory(nextHistory);
    } catch (cause) {
      if (!controller.signal.aborted) toast.error(cause instanceof Error ? cause.message : messages().recordsLoadFailed);
    } finally {
      if (requestController === controller) requestController = null;
      if (!controller.signal.aborted) setLoading(false);
    }
  };

  const onSearch = (value: string) => {
    setQuery(value);
    if (queryTimer !== null) window.clearTimeout(queryTimer);
    queryTimer = window.setTimeout(() => void loadPage(null, value.trim(), []), 250);
  };

  const resultColumns = createMemo(() => customAppRecordsResultColumns(result().columns, props.selectedColumnIds));
  const presentationFields = createMemo(() => new Map((result().presentation?.fields ?? []).map((field) => [field.id, field])));
  const rows = createMemo(() =>
    result().rows.map((row, index) => ({
      ...row,
      rowKey: row.recordId ? `${row.recordId}:${index}` : `row-${index}`,
      href:
        row.recordId && props.rowNavigate
          ? customAppRowHref(props.appId, props.rowNavigate, row.recordId, result().rowNavigationParams?.[row.recordId])
          : null,
    })),
  );
  const cardRecords = createMemo<PublicGridRecord[]>(() => {
    const cards = result().cards;
    if (cards?.records) return cards.records;
    return result().rows.flatMap((row) => {
      if (!row.recordId || !row.tableId) return [];
      const data = Object.fromEntries(
        result().columns.flatMap((column) => (column.fieldId ? [[column.fieldId, row.values[column.key]]] : [])),
      );
      return [
        {
          id: row.recordId,
          tableId: row.tableId,
          data,
          version: row.recordMeta?.version ?? 1,
          finalizedAt: row.recordMeta?.finalizedAt ?? null,
          finalizedBy: row.recordMeta?.finalizedBy ?? null,
          deletedAt: row.recordMeta?.deletedAt ?? null,
          createdBy: row.recordMeta?.createdBy ?? null,
          updatedBy: row.recordMeta?.updatedBy ?? null,
          createdAt: row.recordMeta?.createdAt ?? "1970-01-01T00:00:00.000Z",
          updatedAt: row.recordMeta?.updatedAt ?? "1970-01-01T00:00:00.000Z",
        },
      ];
    });
  });
  const appFileUrl = (preview: GridFilePreview & { contentToken?: string }) => {
    if (!props.endpoint || !preview.contentToken) return "";
    return customAppCardFileUrl(props.endpoint, preview.contentToken);
  };
  const firstColumnId = createMemo(() => resultColumns()[0]?.key);
  const rowRecord = (row: ReturnType<typeof rows>[number]): PublicGridRecord | undefined => {
    if (!row.recordId || !row.tableId) return undefined;
    return {
      id: row.recordId,
      tableId: row.tableId,
      data: Object.fromEntries(result().columns.flatMap((column) => (column.fieldId ? [[column.fieldId, row.values[column.key]]] : []))),
      version: row.recordMeta?.version ?? 1,
      finalizedAt: row.recordMeta?.finalizedAt ?? null,
      finalizedBy: row.recordMeta?.finalizedBy ?? null,
      deletedAt: row.recordMeta?.deletedAt ?? null,
      createdBy: row.recordMeta?.createdBy ?? null,
      updatedBy: row.recordMeta?.updatedBy ?? null,
      createdAt: row.recordMeta?.createdAt ?? "1970-01-01T00:00:00.000Z",
      updatedAt: row.recordMeta?.updatedAt ?? "1970-01-01T00:00:00.000Z",
    };
  };
  const columns = createMemo<DataTableColumn<ReturnType<typeof rows>[number]>[]>(() => {
    const value = resultColumns().map((column) => ({
      id: column.key,
      header: column.label,
      subtitle: column.type,
      value: (row: ReturnType<typeof rows>[number]) => row.values[column.key],
      class: ["text", "longtext", "relation"].includes(column.type) ? "min-w-48" : "min-w-32",
    }));
    if ((props.rowActions?.length ?? 0) > 0) {
      value.push({ id: "__actions", header: messages().actions, subtitle: "", value: (row) => row.recordId, class: "min-w-28" });
    }
    return value;
  });

  const invoke = async (rowId: string, action: CustomAppRenderedRowAction) => {
    const key = `${rowId}:${action.id}`;
    if (props.preview || pendingKey()) return;
    setPendingKey(key);
    let controller: AbortController | null = null;
    try {
      if (action.confirm && !(await prompts.confirm(action.confirm, { title: action.label, confirmText: action.label }))) return;
      controller = new AbortController();
      workflowController = controller;
      const outcome = await invokeCustomAppWorkflow({
        endpoint: action.endpoint,
        body: { rowId, search: appliedQuery() || undefined, cursor: cursor() || undefined },
        signal: controller.signal,
        messages: {
          startFailed: messages().workflowStartFailed,
          statusUnavailable: messages().workflowStatusUnavailable,
          completed: messages().workflowCompleted,
          failed: messages().workflowFailed,
          stillRunning: messages().workflowStillRunning,
        },
      });
      if (outcome.kind === "success") {
        toast.success(outcome.message);
        await loadPage(cursor(), appliedQuery(), history());
      } else if (outcome.kind === "error") toast.error(outcome.message);
      else toast(outcome.message);
    } catch (cause) {
      if (!controller?.signal.aborted) toast.error(cause instanceof Error ? cause.message : messages().workflowStartFailed);
    } finally {
      if (workflowController === controller) workflowController = null;
      setPendingKey(null);
    }
  };

  return (
    <DataTable.Panel class="overflow-hidden">
      <DataTable.Header title={props.title} as="h2" size="md" />
      <Show when={!props.preview && props.searchable}>
        <DataTable.Controls>
          <Show when={props.searchable}>
            <TextInput
              type="search"
              aria-label={messages().searchTitle({ title: props.title })}
              placeholder={messages().searchTitlePlaceholder({ title: props.title })}
              icon="ti ti-search"
              activeIcon="ti ti-search"
              value={query}
              onValueChange={onSearch}
              clearable
              onClear={() => onSearch("")}
            />
          </Show>
        </DataTable.Controls>
      </Show>
      <Show
        when={result().cards}
        fallback={
          <Show
            when={resultColumns().length > 0}
            fallback={
              <Placeholder
                state="error"
                variant="compact"
                align="left"
                title={messages().recordsUnavailable}
                description={messages().fieldsMissingFromView}
              />
            }
          >
            <DataTable
              ariaLabel={props.title}
              rows={rows()}
              columns={columns()}
              getRowId={(row) => row.rowKey}
              density="compact"
              surface="plain"
              class="overflow-x-auto"
              hoverRows={Boolean(props.rowNavigate)}
              rowClass={(row) => (row.href ? "cursor-pointer" : undefined)}
              onRowClick={
                props.rowNavigate
                  ? (row) => {
                      if (!row.href) return;
                      if (props.rowNavigate?.history === "replace") window.location.replace(row.href);
                      else window.location.assign(row.href);
                    }
                  : undefined
              }
              empty={<span>{appliedQuery() ? messages().noRecordsMatch({ query: appliedQuery() }) : props.emptyText}</span>}
              renderCell={({ row, col, value }) => {
                if (col.id === "__actions") {
                  if (!row.recordId) return null;
                  return (
                    <div class="flex min-w-max flex-wrap items-center gap-1">
                      <For each={props.rowActions ?? []}>
                        {(action) => (
                          <Show
                            when={action.showLabel}
                            fallback={
                              <IconButton
                                label={action.label}
                                size="xs"
                                variant="secondary"
                                loading={pendingKey() === `${row.recordId}:${action.id}`}
                                loadingLabel={`${action.label}…`}
                                disabled={props.preview || Boolean(pendingKey())}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  void invoke(row.recordId!, action);
                                }}
                              >
                                <i class={`ti ti-${action.icon}`} aria-hidden="true" />
                              </IconButton>
                            }
                          >
                            <Button
                              size="xs"
                              variant="secondary"
                              loading={pendingKey() === `${row.recordId}:${action.id}`}
                              loadingLabel={`${action.label}…`}
                              disabled={props.preview || Boolean(pendingKey())}
                              onClick={(event) => {
                                event.stopPropagation();
                                void invoke(row.recordId!, action);
                              }}
                            >
                              <Show when={action.icon}>
                                <i class={`ti ti-${action.icon}`} aria-hidden="true" />
                              </Show>
                              {action.label}
                            </Button>
                          </Show>
                        )}
                      </For>
                    </div>
                  );
                }
                const resultColumn = resultColumns().find((column) => column.key === col.id);
                const field = resultColumn?.fieldId ? presentationFields().get(resultColumn.fieldId) : undefined;
                const rendered = field ? (
                  <FieldValue
                    field={field}
                    value={value}
                    record={rowRecord(row)}
                    baseId={props.baseId}
                    dateConfig={props.dateConfig}
                    mode="table"
                    relationValueMode={field.type === "relation" ? "labels" : undefined}
                  />
                ) : (
                  displayValue(value)
                );
                return row.href && col.id === firstColumnId() ? (
                  <a href={row.href} class="group font-medium text-primary" onClick={(event) => event.stopPropagation()}>
                    <span class="whitespace-pre-wrap break-words underline-offset-2 group-hover:underline group-focus-visible:underline">
                      {rendered}
                    </span>{" "}
                    <i class="ti ti-external-link inline-block text-[10px] text-dimmed" aria-hidden="true" />
                  </a>
                ) : (
                  <div class={field?.type === "date" ? "whitespace-nowrap tabular-nums" : "whitespace-pre-wrap break-words"}>
                    {rendered}
                  </div>
                );
              }}
            />
          </Show>
        }
      >
        {(cards) => (
          <RecordCardsView
            items={cardRecords()}
            fields={cards().fields}
            displayConfig={cards().displayConfig}
            filePreviews={cards().filePreviews}
            baseId={props.baseId}
            tableId={cardRecords()[0]?.tableId ?? ""}
            dateConfig={props.dateConfig}
            relationLabels={cards().relationLabels}
            emptyText={appliedQuery() ? messages().noRecordsMatch({ query: appliedQuery() }) : props.emptyText}
            onRecordClick={
              props.rowNavigate
                ? (record) => {
                    const href = customAppRowHref(props.appId, props.rowNavigate!, record.id, result().rowNavigationParams?.[record.id]);
                    if (!href) return;
                    if (props.rowNavigate!.history === "replace") window.location.replace(href);
                    else window.location.assign(href);
                  }
                : undefined
            }
            renderActions={
              (props.rowActions?.length ?? 0) > 0
                ? (record) => (
                    <For each={props.rowActions ?? []}>
                      {(action) => (
                        <Show
                          when={action.showLabel}
                          fallback={
                            <IconButton
                              label={action.label}
                              size="xs"
                              variant="secondary"
                              loading={pendingKey() === `${record.id}:${action.id}`}
                              loadingLabel={`${action.label}…`}
                              disabled={props.preview || Boolean(pendingKey())}
                              onClick={() => void invoke(record.id, action)}
                            >
                              <i class={`ti ti-${action.icon}`} aria-hidden="true" />
                            </IconButton>
                          }
                        >
                          <Button
                            size="xs"
                            variant="secondary"
                            loading={pendingKey() === `${record.id}:${action.id}`}
                            loadingLabel={`${action.label}…`}
                            disabled={props.preview || Boolean(pendingKey())}
                            onClick={() => void invoke(record.id, action)}
                          >
                            <Show when={action.icon}>{(icon) => <i class={`ti ti-${icon()}`} aria-hidden="true" />}</Show>
                            {action.label}
                          </Button>
                        </Show>
                      )}
                    </For>
                  )
                : undefined
            }
            coverUrl={(preview) => appFileUrl(preview as GridFilePreview & { contentToken?: string })}
          />
        )}
      </Show>
      <Show when={!props.preview && (history().length > 0 || Boolean(result().page?.nextCursor))}>
        <DataTable.Footer>
          <div class="flex w-full items-center justify-between gap-2">
            <span class="text-sm text-dimmed">
              {result().page ? `${result().page!.start + 1}–${result().page!.start + result().page!.returned}` : ""}
            </span>
            <div class="flex gap-2">
              <Button
                size="sm"
                variant="secondary"
                disabled={loading() || history().length === 0}
                onClick={() => {
                  const nextHistory = history().slice(0, -1);
                  void loadPage(history().at(-1) ?? null, appliedQuery(), nextHistory);
                }}
              >
                {messages().previous}
              </Button>
              <Button
                size="sm"
                variant="secondary"
                disabled={loading() || !result().page?.nextCursor}
                onClick={() => void loadPage(result().page?.nextCursor ?? null, appliedQuery(), [...history(), cursor()])}
              >
                {messages().next}
              </Button>
            </div>
          </div>
        </DataTable.Footer>
      </Show>
    </DataTable.Panel>
  );
}
