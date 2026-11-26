import { mutation as mutations, timed } from "@k2b/stdlib/solid";
import { useLocale } from "@k2b/ui";
import { Bar, Button, Canvas, Empty, Input, List, type MarkProps, Menu, type MenuEntry, Notice, Pane, Path, Row } from "@k2b/ui/v2";
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { apiClient } from "../../../api/client";
import type { PublicDslQueryPreviewResponse } from "../../../api/gql-public";
import type { PublicField as Field, PublicTable as Table, PublicView as View } from "../../../api/public-dto";
import type { DslQueryPreviewDiagnostic } from "../../../contracts";
import { formatIdentifierRef } from "../../../ref-syntax";
import type { WorkspaceRevision } from "../../../service/workspace-revision";
import GridsFrame, { LiveNotice } from "../frame/GridsFrame";
import { kindMark } from "../frame/kind-marks";
import SaveViewDialog from "../records-view/SaveViewDialog";
import { errorMessage } from "../utils/api-helpers";
import type { NavigationState } from "../workspace/navigation-catalog";
import { GqlSourceEditor } from "./GqlSourceEditor";
import { queryMessages } from "./messages";
import QueryResults from "./QueryResults";
import { launchQueryAssistant } from "./query-assistant";
import { currentSourceForApi, type QueryWorkspaceCurrentSource, visibleFields, visibleViews } from "./query-workspace-model";

export type QueryScreenProps = {
  frame: NavigationState;
  revision?: WorkspaceRevision;
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
};

type Source = {
  id: string;
  name: string;
  /** The table of a view. */
  parent?: string;
  /** The table it reads. */
  tableId: string;
  mark: MarkProps;
  fields: Field[];
  fromLine: string;
  search: string;
};

/** A longer address is not kept: reload then starts with an empty query (the page says so). */
const MAX_SYNCED_QUERY_HREF_LENGTH = 16_384;
const REFERENCE_HREF = "/app/grids/help/grids-gql";

type QueryEditorSelection = Pick<HTMLTextAreaElement, "selectionEnd" | "selectionStart">;

export const insertTextAtEditorSelection = (
  source: string,
  text: string,
  editor: QueryEditorSelection | null,
): { caret: number; value: string } => {
  const start = editor?.selectionStart ?? source.length;
  const end = editor?.selectionEnd ?? start;
  return { caret: start + text.length, value: `${source.slice(0, start)}${text}${source.slice(end)}` };
};

export const replaceOrPrependSourceClause = (source: string, fromLine: string) => {
  if (!source.trim()) return fromLine;
  const lines = source.split(/\r\n|\r|\n/);
  const index = lines.findIndex((line) => /^\s*from\s+(?:table|view)\b/i.test(line));
  if (index < 0) return `${fromLine}\n${source}`;
  lines[index] = fromLine;
  return lines.join("\n");
};

const queryHref = (queryPath: string, query: string, cursor?: string | null) => {
  const params = new URLSearchParams();
  if (query.trim()) params.set("q", query);
  if (cursor) params.set("cursor", cursor);
  const search = params.toString();
  return `${queryPath}${search ? `?${search}` : ""}`;
};
const safeQueryHref = (queryPath: string, query: string, cursor?: string | null) => {
  const href = queryHref(queryPath, query, cursor);
  return href.length <= MAX_SYNCED_QUERY_HREF_LENGTH ? href : queryPath;
};

const isAbortError = (error: unknown) => error instanceof DOMException && error.name === "AbortError";

/**
 * The query of a base on v2: the GQL editor over its result, the readable tables and views beside it. A source puts
 * its `from` line into the query, a field its name at the caret. The query and its page stay in the address, so reload
 * and back show the same; it can be saved as a view or written with AI.
 */
export default function QueryScreen(props: QueryScreenProps) {
  const locale = useLocale();
  const t = () => queryMessages.resolve([locale()]).t;
  const [query, setQuery] = createSignal(props.initialQuery);
  const [preview, setPreview] = createSignal<PublicDslQueryPreviewResponse | null>(props.initialPreview ?? null);
  const [loading, setLoading] = createSignal(false);
  const [pageCursor, setPageCursor] = createSignal<string | null>(props.initialCursor ?? null);
  const [pageHistory, setPageHistory] = createSignal<Array<string | null>>([]);
  const [sourceSearch, setSourceSearch] = createSignal("");
  const [saving, setSaving] = createSignal(false);
  const apiSource = createMemo(() => currentSourceForApi(props.currentSource));
  const [took, setTook] = createSignal<number | null>(null);
  let editor: HTMLTextAreaElement | undefined;

  const assistant = mutations.create({
    mutation: async () =>
      launchQueryAssistant({
        baseId: props.baseId,
        baseName: props.baseName,
        query: query(),
        currentSource: props.currentSource,
        title: t().queryWithAi,
        prompt: t().queryAiPrompt,
      }),
    onSuccess: (result) => {
      if (result) window.location.assign(result.href);
    },
  });

  const sources = createMemo<Source[]>(() =>
    props.tables
      .filter((table) => !table.deletedAt)
      .flatMap((table) => {
        const fields = visibleFields(props.fieldsByTable[table.id]);
        const fieldWords = fields.map((field) => `${field.name} ${field.type}`).join(" ");
        return [
          {
            id: `table:${table.id}`,
            name: table.name,
            tableId: table.id,
            mark: kindMark("table", table.icon),
            fields,
            fromLine: `from table ${formatIdentifierRef(table.name)}`,
            search: [table.name, table.description ?? "", fieldWords].join(" ").toLowerCase(),
          },
          ...visibleViews(props.viewsByTable[table.id]).map((view) => ({
            id: `view:${view.id}`,
            name: view.name,
            parent: table.name,
            tableId: table.id,
            mark: kindMark("view", view.icon),
            fields,
            fromLine: `from view ${formatIdentifierRef(view.name)}`,
            search: [view.name, table.name, fieldWords].join(" ").toLowerCase(),
          })),
        ];
      }),
  );
  const shownSources = createMemo(() => {
    const search = sourceSearch().trim().toLowerCase();
    return search ? sources().filter((source) => source.search.includes(search)) : sources();
  });

  let previewToken = 0;
  let previewAbort: AbortController | undefined;
  let lastPreviewQuery = props.initialPreview !== undefined ? props.initialQuery : "";

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
    const started = performance.now();
    try {
      const response = await apiClient.gql["by-base"][":baseId"].execute.$post(
        {
          param: { baseId: props.baseId },
          json: { query: source, pageSize: 100, ...(cursor ? { cursor } : {}), ...(apiSource() ? { currentSource: apiSource() } : {}) },
        },
        { init: { signal: abort.signal } },
      );
      if (!response.ok) throw new Error(await errorMessage(response, t().executeFailed));
      const data = await response.json();
      if (token !== previewToken) return false;
      setTook(Math.round(performance.now() - started));
      setPreview(data);
      return true;
    } catch (error) {
      if (isAbortError(error)) return false;
      if (token === previewToken) setPreview({ ok: false, diagnostics: [{ message: t().previewFailed }] });
      return false;
    } finally {
      if (token === previewToken) {
        previewAbort = undefined;
        setLoading(false);
      }
    }
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
  });

  const onInput = (next: string) => {
    if (next === query()) return;
    setQuery(next);
    window.history.replaceState(window.history.state, "", safeQueryHref(props.queryPath, next));
  };
  const syncCursor = (cursor: string | null) =>
    window.history.replaceState(window.history.state, "", safeQueryHref(props.queryPath, query(), cursor));

  const insertAtCaret = (text: string) => {
    const field = editor;
    const insertion = insertTextAtEditorSelection(query(), text, field ?? null);
    onInput(insertion.value);
    if (!field) return;
    requestAnimationFrame(() => {
      field.focus();
      field.setSelectionRange(insertion.caret, insertion.caret);
    });
  };

  const nextPage = async (cursor: string) => {
    if (!(await loadPreview(query(), cursor))) return;
    setPageHistory((history) => [...history, pageCursor()]);
    setPageCursor(cursor);
    syncCursor(cursor);
  };
  const previousPage = async () => {
    const history = pageHistory();
    if (history.length === 0 && !pageCursor()) return;
    const cursor = history.length > 0 ? (history.at(-1) ?? null) : null;
    if (!(await loadPreview(query(), cursor))) return;
    setPageHistory(history.slice(0, -1));
    setPageCursor(cursor);
    syncCursor(cursor);
  };

  /** Two starts for this base: rows of its first table, and a sum by month where it has an amount and a date. */
  const examples = (): Array<{ label: string; code: string }> => {
    const table = props.tables.find((each) => !each.deletedAt);
    if (!table) return [];
    const fields = props.fieldsByTable[table.id] ?? [];
    const amount = fields.find((field) => ["number", "percent", "decimal"].includes(field.type));
    const date = fields.find((field) => field.type === "date");
    const from = `from table ${formatIdentifierRef(table.name)}`;
    return [
      { label: t().rows, code: `${from}\nselect ${formatIdentifierRef(fields[0]?.name ?? "field")}\nlimit 20` },
      ...(amount && date
        ? [
            {
              label: t().grouped,
              code: `${from}\ngroup by ${formatIdentifierRef(date.name)} by month\naggregate sum(${formatIdentifierRef(amount.name)}) as total\nsort total desc`,
            },
          ]
        : []),
    ];
  };

  /** The view's source from the query: the server compiles it, and its findings say why it cannot be one. */
  const draft = async () => {
    const response = await apiClient.gql["by-base"][":baseId"]["compile-view"].$post({
      param: { baseId: props.baseId },
      json: { query: query(), ...(apiSource() ? { currentSource: apiSource() } : {}) },
    });
    if (!response.ok) throw new Error(await errorMessage(response, t().compileFailed));
    const compiled = await response.json();
    if (!compiled.ok)
      throw new Error(compiled.diagnostics.map((item: DslQueryPreviewDiagnostic) => item.message).join("\n") || t().saveViewFailed);
    return { tableId: compiled.tableId, source: compiled.source };
  };

  const success = createMemo(() => {
    const current = preview();
    return current?.ok ? current : null;
  });
  const diagnostics = createMemo(() => {
    const current = preview();
    return current && !current.ok ? current.diagnostics : [];
  });

  /** Records lead with their table's mark, groups with the mark of a view (what a grouped query saves as). */
  const resultMark = (result: { mode: "rows" | "groups"; columns: Array<{ tableId?: string }> }): MarkProps => {
    const tableId = result.columns.find((column) => column.tableId)?.tableId;
    const table = props.tables.find((each) => each.id === tableId);
    return result.mode === "groups" ? kindMark("view") : kindMark("table", table?.icon);
  };

  const sourcePath = () => {
    const source = props.currentSource;
    if (!source) return null;
    const tableId =
      source.kind === "table"
        ? source.tableId
        : Object.entries(props.viewsByTable).find(([, views]) => views.some((view) => view.id === source.viewId))?.[0];
    if (!tableId) return [{ label: source.label }, { label: t().query }];
    const view = source.kind === "view" ? `/view/${encodeURIComponent(source.viewId)}` : "";
    return [
      { label: source.label, href: `/app/grids/${encodeURIComponent(props.baseId)}/table/${encodeURIComponent(tableId)}${view}` },
      { label: t().query },
    ];
  };

  const more = (): MenuEntry[] => [
    ...(examples().length
      ? [{ title: t().examples, items: examples().map((example) => ({ ...example, onClick: () => onInput(example.code) })) }]
      : []),
    { label: t().referenceLabel, icon: "help", href: REFERENCE_HREF },
  ];

  return (
    <GridsFrame
      state={props.frame}
      activeKeys={
        props.currentSource
          ? [props.currentSource.kind === "table" ? `table:${props.currentSource.tableId}` : `view:${props.currentSource.viewId}`]
          : []
      }
      revision={props.revision}
      head={
        <Bar
          start={<Show when={sourcePath()}>{(items) => <Path label={t().query} items={items()} />}</Show>}
          end={
            <>
              <Button icon="sparkles" busy={assistant.loading()} onClick={() => void assistant.mutate(undefined)}>
                {t().queryWithAi}
              </Button>
              <Menu items={more()} />
            </>
          }
        />
      }
      primary={{ label: t().saveAsView, icon: "bookmark-plus", disabled: !query().trim(), onClick: () => setSaving(true) }}
    >
      <Pane.Split>
        <Pane label={t().query} scrollKey="grids-query">
          <LiveNotice />
          <Canvas label={t().gqlQueryLabel} height={220}>
            <div style="height:100%">
              <GqlSourceEditor
                baseId={props.baseId}
                currentSource={apiSource()}
                value={query}
                onValueChange={onInput}
                textareaRef={(element) => (editor = element)}
                restoreExpansionOnBackspace={false}
                variant="embedded"
                lineNumbers
                markedLine={diagnostics()[0]?.line}
                fill
                placeholder={"from table Orders\nwhere Status = 'Open'\nsort CreatedAt desc\nlimit 50"}
                aria-label={t().gqlQueryLabel}
              />
            </div>
          </Canvas>
          <Show when={queryHref(props.queryPath, query()).length > MAX_SYNCED_QUERY_HREF_LENGTH}>
            <Notice tone="warn">{t().queryTooLong}</Notice>
          </Show>
          <Show when={assistant.error()}>{(error) => <Notice tone="bad">{error().message}</Notice>}</Show>
          <For each={diagnostics()}>
            {(diagnostic) => (
              <Notice
                tone="bad"
                title={
                  diagnostic.line
                    ? `${t().line({ line: diagnostic.line })}${diagnostic.column ? ` · ${t().column({ column: diagnostic.column })}` : ""}`
                    : t().query
                }
              >
                {diagnostic.message}
              </Notice>
            )}
          </For>
          <Show
            when={success()}
            fallback={
              <Show when={!preview()}>
                <Empty icon="code" text={loading() ? t().runningQuery : t().writeQuery} />
              </Show>
            }
          >
            {(result) => (
              <QueryResults
                result={result()}
                mark={resultMark(result())}
                baseId={props.baseId}
                fieldsByTable={props.fieldsByTable}
                loading={loading()}
                took={took()}
                canGoBack={pageHistory().length > 0 || pageCursor() !== null}
                backToFirst={pageHistory().length === 0}
                onPrevious={() => void previousPage()}
                onNext={(cursor) => void nextPage(cursor)}
              />
            )}
          </Show>
        </Pane>
        <Pane
          label={t().sources}
          width={{ min: 240, default: 320 }}
          scrollKey="grids-query-sources"
          head={
            <Bar
              start={
                <Input
                  type="search"
                  icon="search"
                  label={t().searchSourcesLabel}
                  placeholder={t().searchSources}
                  value={sourceSearch()}
                  onInput={setSourceSearch}
                />
              }
            />
          }
        >
          <Show
            when={shownSources().length > 0}
            fallback={<Empty icon="database-off" text={sourceSearch().trim() ? t().noMatchingSources : t().noReadableSources} />}
          >
            <List
              label={t().sources}
              items={shownSources()}
              rowKey={(source) => source.id}
              row={(source) => (
                <Row
                  mark={source.mark}
                  lines={[
                    source.name,
                    `${source.parent ? t().viewOf({ table: source.parent }) : t().tableKind} · ${t().fieldCount({ count: source.fields.length })}`,
                  ]}
                  onOpen={() => onInput(replaceOrPrependSourceClause(query(), source.fromLine))}
                  end={
                    <Menu
                      icon="list-details"
                      label={t().insertFieldOf({ source: source.name })}
                      disabled={source.fields.length === 0}
                      items={[
                        {
                          title: t().insertField,
                          items: source.fields.map((field) => ({
                            label: field.name,
                            meta: field.type,
                            onClick: () => insertAtCaret(formatIdentifierRef(field.name)),
                          })),
                        },
                      ]}
                    />
                  }
                />
              )}
            />
          </Show>
        </Pane>
      </Pane.Split>
      <SaveViewDialog
        open={saving()}
        onOpenChange={setSaving}
        draft={draft}
        onSaved={(view) => window.location.assign(`/app/grids/${props.baseId}/table/${view.tableId}/view/${view.id}`)}
        canShare
      />
    </GridsFrame>
  );
}
