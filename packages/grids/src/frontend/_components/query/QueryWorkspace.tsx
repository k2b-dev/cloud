import { mutation as mutations, timed } from "@k2b/stdlib/solid";
import { Button, NoticeCard, Panes, type PanesLayout, prompts, ScrollArea, TextInput, Tooltip, useLocale } from "@k2b/ui";
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { apiClient } from "../../../api/client";
import type { PublicDslQueryPreviewResponse } from "../../../api/gql-public";
import type { PublicField as Field, PublicTable as Table, PublicView as View } from "../../../api/public-dto";
import type { DslQueryPreviewDiagnostic } from "../../../contracts";
import { formatIdentifierRef } from "../../../ref-syntax";
import { errorMessage } from "../utils/api-helpers";
import { GqlSourceEditor } from "./GqlSourceEditor";
import { queryMessages } from "./messages";
import QueryResultTable from "./QueryResultTable";
import { launchQueryAssistant } from "./query-assistant";
import {
  currentSourceForApi,
  type QueryWorkspaceCurrentSource,
  sourceFieldsForSearch,
  visibleFields,
  visibleViews,
} from "./query-workspace-model";

type Props = {
  baseId: string;
  baseName?: string;
  initialQuery: string;
  initialCursor?: string | null;
  initialPreview?: PublicDslQueryPreviewResponse | null;
  queryPath: string;
  currentSource?: QueryWorkspaceCurrentSource;
  tables: Table[];
  fieldsByTable: Record<string, Field[]>;
  viewsByTable: Record<string, View[]>;
  syncQueryToUrl?: boolean;
};

type QuerySourceRow = {
  id: string;
  kind: "table" | "view";
  name: string;
  parent?: string;
  icon: string;
  metaLabel: string;
  fields: Field[];
  fromLine: string;
  search: string;
};
const MAX_SYNCED_QUERY_HREF_LENGTH = 16_384;
const QUERY_EDITOR_SELECTOR = "textarea[data-grids-query-editor]";

type QueryEditorSelection = Pick<HTMLTextAreaElement, "selectionEnd" | "selectionStart">;

export const queryEditorForScope = (scope: ParentNode | undefined): HTMLTextAreaElement | null =>
  scope?.querySelector<HTMLTextAreaElement>(QUERY_EDITOR_SELECTOR) ?? null;

export const insertTextAtEditorSelection = (
  source: string,
  text: string,
  editor: QueryEditorSelection | null,
): { caret: number; value: string } => {
  const start = editor?.selectionStart ?? source.length;
  const end = editor?.selectionEnd ?? start;
  return {
    caret: start + text.length,
    value: `${source.slice(0, start)}${text}${source.slice(end)}`,
  };
};

const isAbortError = (error: unknown): boolean => error instanceof DOMException && error.name === "AbortError";

const createQueryWorkspacePanesLayout = (): PanesLayout => ({
  version: 2,
  root: {
    type: "split",
    direction: "vertical",
    ratio: 0.56,
    first: { type: "group", items: ["results"], active: "results" },
    second: {
      type: "split",
      direction: "horizontal",
      ratio: 0.62,
      first: { type: "group", items: ["query"], active: "query" },
      second: { type: "group", items: ["sources"], active: "sources" },
    },
  },
});

const queryHref = (queryPath: string, query: string, cursor?: string | null) => {
  const params = new URLSearchParams();
  if (query.trim()) params.set("q", query);
  if (cursor) params.set("cursor", cursor);
  const search = params.toString();
  return `${queryPath}${search ? `?${search}` : ""}`;
};

const queryReferenceHref = () => "/app/grids/help/grids-gql";

const openQueryReferenceWindow = () => {
  if (typeof window === "undefined") return;
  window.open(queryReferenceHref(), "grids-gql-reference", "popup,width=1120,height=820,resizable=yes,scrollbars=yes");
};

const safeQueryHref = (queryPath: string, query: string, cursor?: string | null) => {
  const href = queryHref(queryPath, query, cursor);
  return href.length <= MAX_SYNCED_QUERY_HREF_LENGTH ? href : queryPath;
};

const compactCount = (count: number, suffix: string) => `${count}${suffix}`;

const replaceOrPrependSourceClause = (source: string, fromLine: string) => {
  if (!source.trim()) return fromLine;
  const lines = source.split(/\r\n|\r|\n/);
  const sourceIndex = lines.findIndex((line) => /^\s*from\s+(?:table|view)\b/i.test(line));
  if (sourceIndex >= 0) {
    lines[sourceIndex] = fromLine;
    return lines.join("\n");
  }
  return `${fromLine}\n${source}`;
};

function QueryPreview(props: {
  preview: PublicDslQueryPreviewResponse | null;
  loading: boolean;
  baseId: string;
  tables: Table[];
  fieldsByTable: Record<string, Field[]>;
  canGoBack: boolean;
  backLabel: "Previous" | "First page";
  onPrevious: () => void;
  onNext: (cursor: string) => void;
}) {
  const { t } = queryMessages.resolve([useLocale()()]);
  const success = createMemo(() => (props.preview?.ok ? props.preview : null));
  const diagnostics = createMemo(() => (props.preview && !props.preview.ok ? props.preview.diagnostics : []));
  return (
    <div class="flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-surface">
      <Show
        when={props.preview}
        fallback={
          <div class="flex flex-1 items-center justify-center text-sm text-dimmed">
            <div class="flex max-w-sm flex-col items-center gap-2 text-center">
              <span class="state-placeholder-icon state-placeholder-icon-panel">
                <i class={props.loading ? "ti ti-loader-2 animate-spin text-lg" : "ti ti-table-spark text-lg"} />
              </span>
              <p class="font-medium text-primary">{props.loading ? t.runningQuery : t.noResultYet}</p>
            </div>
          </div>
        }
      >
        <Show
          when={success()}
          fallback={
            <div class="flex min-h-0 flex-1 flex-col overflow-hidden">
              <div class="flex shrink-0 items-center justify-between gap-2 bg-[var(--ui-surface-subtle)] px-3 py-2 text-xs">
                <span class="inline-flex items-center gap-1.5 font-medium text-red-700 dark:text-red-300">
                  <i class="ti ti-alert-triangle" /> {t.diagnostics}
                </span>
                <div class="flex items-center gap-2">
                  <span class="text-dimmed">{t.issueCount({ count: diagnostics().length })}</span>
                  <Show when={props.canGoBack}>
                    <Button variant="ghost" size="sm" type="button" disabled={props.loading} onClick={props.onPrevious}>
                      <i class="ti ti-chevrons-left" aria-hidden="true" /> {props.backLabel}
                    </Button>
                  </Show>
                </div>
              </div>
              <ScrollArea class="flex min-h-0 flex-1 flex-col gap-2 p-3 text-sm">
                <For each={diagnostics()}>
                  {(diagnostic) => (
                    <div class="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-red-800 dark:border-red-900 dark:bg-red-950/45 dark:text-red-300">
                      <div class="mb-1 flex flex-wrap items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide">
                        <Show when={diagnostic.line} fallback={<span>{t.query}</span>}>
                          {(line) => (
                            <span class="rounded bg-white/70 px-1.5 py-0.5 dark:bg-black/20">
                              {t.line({ line: line() })}
                              <Show when={diagnostic.column}>{(column) => ` · ${t.column({ column: column() })}`}</Show>
                            </span>
                          )}
                        </Show>
                      </div>
                      <p class="leading-relaxed">{diagnostic.message}</p>
                    </div>
                  )}
                </For>
              </ScrollArea>
            </div>
          }
        >
          {(preview) => (
            <QueryResultTable
              result={preview()}
              baseId={props.baseId}
              fieldsByTable={props.fieldsByTable}
              scrollPreserveKey="grids-query-preview"
              loading={props.loading}
              canGoBack={props.canGoBack}
              backLabel={props.backLabel}
              onPrevious={props.onPrevious}
              onNext={props.onNext}
            />
          )}
        </Show>
      </Show>
    </div>
  );
}

export default function QueryWorkspace(props: Props) {
  const { t } = queryMessages.resolve([useLocale()()]);
  const [query, setQuery] = createSignal(props.initialQuery);
  const [preview, setPreview] = createSignal<PublicDslQueryPreviewResponse | null>(props.initialPreview ?? null);
  const [loading, setLoading] = createSignal(false);
  const [pageCursor, setPageCursor] = createSignal<string | null>(props.initialCursor ?? null);
  const [pageHistory, setPageHistory] = createSignal<Array<string | null>>([]);
  const [layout, setLayout] = createSignal(createQueryWorkspacePanesLayout());
  const [sourceSearch, setSourceSearch] = createSignal("");
  const apiSource = createMemo(() => currentSourceForApi(props.currentSource));
  const assistant = mutations.create({
    mutation: async () =>
      launchQueryAssistant({
        baseId: props.baseId,
        baseName: props.baseName,
        query: query(),
        currentSource: props.currentSource,
        title: t.queryWithAi,
        prompt: t.queryAiPrompt,
      }),
    onSuccess: (result) => window.location.assign(result.href),
  });
  const sourceTables = createMemo(() => props.tables.filter((table) => !table.deletedAt));
  const sourceRows = createMemo<QuerySourceRow[]>(() =>
    sourceTables().flatMap((table) => {
      const fields = visibleFields(props.fieldsByTable[table.id]);
      const tableRow: QuerySourceRow = {
        id: `table:${table.id}`,
        kind: "table",
        name: table.name,
        icon: table.icon ?? "ti ti-table",
        metaLabel: compactCount(fields.length, "f"),
        fields,
        fromLine: `from table ${formatIdentifierRef(table.name)}`,
        search: [table.name, table.description ?? "", fields.map((field) => `${field.name} ${field.type}`).join(" ")]
          .join(" ")
          .toLowerCase(),
      };
      const viewRows = visibleViews(props.viewsByTable[table.id]).map(
        (view): QuerySourceRow => ({
          id: `view:${view.id}`,
          kind: "view",
          name: view.name,
          parent: table.name,
          icon: "ti ti-table-spark",
          metaLabel: `view · ${compactCount(fields.length, "f")}`,
          fields,
          fromLine: `from view ${formatIdentifierRef(view.name)}`,
          search: [view.name, table.name, fields.map((field) => `${field.name} ${field.type}`).join(" ")].join(" ").toLowerCase(),
        }),
      );
      return [tableRow, ...viewRows];
    }),
  );
  const filteredSourceRows = createMemo(() => {
    const search = sourceSearch().trim().toLowerCase();
    if (!search) return sourceRows();
    return sourceRows().filter((source) => source.search.includes(search));
  });
  let previewToken = 0;
  let previewAbort: AbortController | undefined;
  let lastPreviewQuery = props.initialPreview !== undefined ? props.initialQuery : "";
  let queryEditorScope: HTMLDivElement | undefined;

  createEffect(() => {
    setQuery((current) => (current === props.initialQuery ? current : props.initialQuery));
    if (props.initialPreview !== undefined) {
      setPreview(props.initialPreview);
      setLoading(false);
      setPageCursor(props.initialCursor ?? null);
      setPageHistory([]);
      lastPreviewQuery = props.initialQuery;
    }
  });

  const loadPreview = async (source: string, cursor?: string | null): Promise<boolean> => {
    const token = ++previewToken;
    previewAbort?.abort();
    previewAbort = undefined;
    if (!source.trim()) {
      setPreview(null);
      setLoading(false);
      return false;
    }
    const abort = new AbortController();
    previewAbort = abort;
    setLoading(true);
    try {
      const response = await apiClient.gql["by-base"][":baseId"].execute.$post(
        {
          param: { baseId: props.baseId },
          json: { query: source, pageSize: 100, ...(cursor ? { cursor } : {}), ...(apiSource() ? { currentSource: apiSource() } : {}) },
        },
        { init: { signal: abort.signal } },
      );
      if (!response.ok) throw new Error(await errorMessage(response, t.executeFailed));
      const data = await response.json();
      if (token === previewToken) {
        setPreview(data);
        return true;
      }
    } catch (error) {
      if (isAbortError(error)) return false;
      if (token === previewToken) {
        setPreview({
          ok: false,
          diagnostics: [{ message: t.previewFailed }],
        });
      }
      return false;
    } finally {
      if (token === previewToken) {
        previewAbort = undefined;
        setLoading(false);
      }
    }
    return false;
  };

  const previewDebounce = timed.debounce(loadPreview, 250);

  createEffect(() => {
    const source = query();
    if (source === lastPreviewQuery) return;
    lastPreviewQuery = source;
    setPageCursor(null);
    setPageHistory([]);
    previewDebounce.debouncedFn(source, null);
  });

  onCleanup(() => {
    previewToken++;
    previewAbort?.abort();
    previewAbort = undefined;
  });

  const onInput = (next: string) => {
    if (next === query()) return;
    setQuery(next);
    if (props.syncQueryToUrl !== false && typeof window !== "undefined") {
      window.history.replaceState(window.history.state, "", safeQueryHref(props.queryPath, next));
    }
  };

  const syncPageCursorToUrl = (cursor: string | null) => {
    if (props.syncQueryToUrl === false || typeof window === "undefined") return;
    window.history.replaceState(window.history.state, "", safeQueryHref(props.queryPath, query(), cursor));
  };

  const insertExample = (source: string) => {
    onInput(source);
  };

  const insertSource = (source: QuerySourceRow) => {
    onInput(replaceOrPrependSourceClause(query(), source.fromLine));
  };

  const insertAtEditorCursor = (text: string) => {
    const textarea = queryEditorForScope(queryEditorScope);
    const insertion = insertTextAtEditorSelection(query(), text, textarea);
    onInput(insertion.value);
    if (!textarea || typeof requestAnimationFrame === "undefined") return;
    requestAnimationFrame(() => {
      textarea.focus();
      textarea.setSelectionRange(insertion.caret, insertion.caret);
    });
  };

  const insertField = (field: Field) => {
    insertAtEditorCursor(formatIdentifierRef(field.name));
  };

  const saveViewMut = mutations.create<void, void>({
    mutation: async () => {
      const compiledResponse = await apiClient.gql["by-base"][":baseId"]["compile-view"].$post({
        param: { baseId: props.baseId },
        json: { query: query(), ...(apiSource() ? { currentSource: apiSource() } : {}) },
      });
      if (!compiledResponse.ok) throw new Error(await errorMessage(compiledResponse, t.compileFailed));
      const compiled = await compiledResponse.json();
      if (!compiled.ok) {
        const message = compiled.diagnostics.map((diagnostic: DslQueryPreviewDiagnostic) => diagnostic.message).join("\n");
        prompts.error(message || t.saveViewFailed);
        return;
      }

      const result = await prompts.form({
        title: t.saveView,
        icon: "ti ti-bookmark-plus",
        fields: {
          name: {
            type: "text",
            label: t.name,
            required: true,
            placeholder: t.openOrdersExample,
          },
          shared: {
            type: "boolean",
            label: t.shareView,
            default: false,
          },
        },
        confirmText: t.save,
      });
      if (!result) return;

      const createResponse = await apiClient.views["by-table"][":tableId"].$post({
        param: { tableId: compiled.tableId },
        json: {
          name: String(result.name).trim(),
          source: compiled.source,
          shared: Boolean(result.shared),
        },
      });
      if (!createResponse.ok) throw new Error(await errorMessage(createResponse, t.saveViewFailed));
      const view = await createResponse.json();
      const table = props.tables.find((item) => item.id === view.tableId);
      if (typeof window !== "undefined" && table) {
        window.location.assign(`/app/grids/${props.baseId}/table/${table.id}/view/${view.id}`);
      }
    },
    onError: (error) => prompts.error(error.message),
  });

  const handleSaveAsView = () => {
    if (!query().trim() || saveViewMut.loading()) return;
    saveViewMut.mutate(undefined);
  };

  const saveButtonLabel = () => t.save;
  const saveButtonIcon = () => (saveViewMut.loading() ? "ti ti-loader-2 animate-spin" : "ti ti-bookmark-plus");
  const handleSave = () => handleSaveAsView();
  const handleNextPage = async (cursor: string) => {
    if (!(await loadPreview(query(), cursor))) return;
    setPageHistory((history) => [...history, pageCursor()]);
    setPageCursor(cursor);
    syncPageCursorToUrl(cursor);
  };
  const handlePreviousPage = async () => {
    const history = pageHistory();
    if (history.length === 0 && !pageCursor()) return;
    const cursor = history.length > 0 ? (history.at(-1) ?? null) : null;
    if (!(await loadPreview(query(), cursor))) return;
    setPageHistory(history.slice(0, -1));
    setPageCursor(cursor);
    syncPageCursorToUrl(cursor);
  };

  const firstTable = () => props.tables[0];
  const firstNumericField = () =>
    firstTable()
      ? props.fieldsByTable[firstTable()!.id]?.find((field) => ["number", "percent", "decimal"].includes(field.type))
      : undefined;
  const firstDateField = () => (firstTable() ? props.fieldsByTable[firstTable()!.id]?.find((field) => field.type === "date") : undefined);

  const examples = () => {
    const table = firstTable();
    if (!table) return [];
    const amount = firstNumericField();
    const date = firstDateField();
    const firstField = props.fieldsByTable[table.id]?.[0];
    return [
      {
        label: t.rows,
        code: `from table ${formatIdentifierRef(table.name)}\nselect ${formatIdentifierRef(firstField?.name ?? "field")}\nlimit 20`,
      },
      ...(amount && date
        ? [
            {
              label: t.grouped,
              code: `from table ${formatIdentifierRef(table.name)}\ngroup by ${formatIdentifierRef(date.name)} by month\naggregate sum(${formatIdentifierRef(amount.name)}) as total\nsort total desc`,
            },
          ]
        : []),
    ];
  };

  return (
    <div class="flex min-h-0 flex-1 flex-col bg-surface p-2" data-scroll-preserve="grids-query-workspace">
      <Panes
        layout={layout()}
        onLayoutChange={setLayout}
        class="h-full w-full flex-1"
        items={[
          {
            id: "results",
            title: t.results,
            icon: "ti ti-table-spark",
            render: () => (
              <QueryPreview
                preview={preview()}
                loading={loading()}
                baseId={props.baseId}
                tables={props.tables}
                fieldsByTable={props.fieldsByTable}
                canGoBack={pageHistory().length > 0 || pageCursor() !== null}
                backLabel={pageHistory().length > 0 ? "Previous" : "First page"}
                onPrevious={handlePreviousPage}
                onNext={handleNextPage}
              />
            ),
          },
          {
            id: "query",
            title: t.query,
            icon: "ti ti-code",
            render: () => (
              <section class="flex h-full min-h-0 flex-col overflow-hidden">
                <div ref={(element) => (queryEditorScope = element)} class="min-h-0 flex-1">
                  <GqlSourceEditor
                    baseId={props.baseId}
                    currentSource={apiSource()}
                    value={query}
                    onValueChange={onInput}
                    restoreExpansionOnBackspace={false}
                    variant="paper"
                    fill
                    placeholder={"from table Orders\nwhere Status = 'Open'\nsort CreatedAt desc\nlimit 50\noffset 0"}
                    aria-label={t.gqlQueryLabel}
                    data-grids-query-editor
                  />
                </div>
                <Show when={queryHref(props.queryPath, query()).length > MAX_SYNCED_QUERY_HREF_LENGTH}>
                  <NoticeCard tone="warning" icon={false} class="mx-3 mt-3">
                    {t.queryTooLong}
                  </NoticeCard>
                </Show>

                <div class="flex shrink-0 flex-wrap items-center gap-2 pt-2">
                  <Button
                    variant="ai"
                    size="sm"
                    type="button"
                    disabled={assistant.loading()}
                    onClick={() => void assistant.mutate(undefined)}
                  >
                    <i class={assistant.loading() ? "ti ti-loader-2 animate-spin" : "ti ti-sparkles"} /> {t.queryWithAi}
                  </Button>
                  <div class="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                    <For each={examples()}>
                      {(example) => (
                        <Button variant="secondary" size="sm" type="button" onClick={() => insertExample(example.code)}>
                          <i class="ti ti-sparkles" /> {example.label}
                        </Button>
                      )}
                    </For>
                  </div>
                  <Button variant="secondary" size="sm" type="button" onClick={openQueryReferenceWindow}>
                    <i class="ti ti-external-link" /> {t.referenceLabel}
                  </Button>
                  <Button
                    variant="primary"
                    size="sm"
                    type="button"
                    onClick={handleSave}
                    disabled={!query().trim() || saveViewMut.loading()}
                  >
                    <i class={saveButtonIcon()} /> {saveButtonLabel()}
                  </Button>
                </div>
                <Show when={assistant.error()}>
                  {(error) => (
                    <NoticeCard tone="danger" class="mt-2">
                      {error().message}
                    </NoticeCard>
                  )}
                </Show>
              </section>
            ),
          },
          {
            id: "sources",
            title: t.sources,
            icon: "ti ti-database",
            render: () => (
              <section class="flex h-full min-h-0 flex-col gap-1 overflow-hidden">
                <TextInput
                  type="search"
                  icon="ti ti-search"
                  activeIcon="ti ti-search"
                  placeholder={t.searchSources}
                  aria-label={t.searchSourcesLabel}
                  value={sourceSearch}
                  onValueChange={setSourceSearch}
                  clearable
                />

                <ScrollArea class="min-h-0 flex-1">
                  <Show
                    when={filteredSourceRows().length > 0}
                    fallback={
                      <div class="flex h-full items-center justify-center p-6 text-center text-sm text-dimmed">
                        <div class="flex max-w-xs flex-col items-center gap-2">
                          <span class="state-placeholder-icon state-placeholder-icon-panel">
                            <i class="ti ti-database-off text-lg" />
                          </span>
                          <span>{sourceSearch().trim() ? t.noMatchingSources : t.noReadableSources}</span>
                        </div>
                      </div>
                    }
                  >
                    <div class="space-y-2">
                      <For each={filteredSourceRows()}>
                        {(source) => {
                          const visibleSourceFields = () => sourceFieldsForSearch(source.fields, sourceSearch());
                          const shown = () => visibleSourceFields().shown;
                          const hidden = () => visibleSourceFields().hidden;
                          return (
                            <article class="paper px-2 py-1.5">
                              <div class="flex items-start justify-between gap-2">
                                <Tooltip.Anchor content={t.insertSource({ source: source.fromLine })} class="min-w-0 flex-1">
                                  <button
                                    type="button"
                                    class="group flex min-w-0 flex-1 items-center gap-2 text-left"
                                    onClick={() => insertSource(source)}
                                  >
                                    <span class="grid h-5 w-5 shrink-0 place-items-center rounded-[var(--ui-radius-control)] bg-[var(--ui-surface-subtle)] text-xs text-secondary">
                                      <i class={source.icon} />
                                    </span>
                                    <span class="min-w-0">
                                      <span class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
                                        <span class="truncate text-xs font-medium text-primary group-hover:text-[var(--ui-app-accent-text)]">
                                          {source.name}
                                        </span>
                                        <span class="text-[10px] text-dimmed">{source.metaLabel}</span>
                                      </span>
                                      <Show when={source.parent}>
                                        <span class="block truncate text-[10px] text-dimmed">
                                          {t.sourceParent({ parent: source.parent! })}
                                        </span>
                                      </Show>
                                    </span>
                                  </button>
                                </Tooltip.Anchor>
                                <Tooltip.Anchor content={t.insertSource({ source: source.fromLine })}>
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    type="button"
                                    class="shrink-0 px-2"
                                    onClick={() => insertSource(source)}
                                  >
                                    from
                                  </Button>
                                </Tooltip.Anchor>
                              </div>

                              <div class="mt-1.5 flex flex-wrap gap-1">
                                <For each={shown()}>
                                  {(field) => (
                                    <Tooltip.Anchor content={field.description || `${field.name} (${field.type})`}>
                                      <button
                                        type="button"
                                        class="inline-flex max-w-full items-baseline gap-1 rounded-[var(--ui-radius-control)] bg-[var(--ui-surface-subtle)] px-1.5 py-0.5 text-left text-[11px] leading-4 text-secondary hover:bg-[var(--ui-hover)] hover:text-[var(--ui-app-accent-text)]"
                                        onClick={() => insertField(field)}
                                      >
                                        <span class="truncate">{field.name}</span>
                                        <span class="text-dimmed">{field.type}</span>
                                      </button>
                                    </Tooltip.Anchor>
                                  )}
                                </For>
                                <Show when={hidden() > 0}>
                                  <span class="rounded-[var(--ui-radius-control)] bg-[var(--ui-surface-subtle)] px-1.5 py-0.5 text-[10px] text-dimmed">
                                    +{hidden()}
                                  </span>
                                </Show>
                              </div>
                            </article>
                          );
                        }}
                      </For>
                    </div>
                  </Show>
                </ScrollArea>
              </section>
            ),
          },
        ]}
      />
    </div>
  );
}
