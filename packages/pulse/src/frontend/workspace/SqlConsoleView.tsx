import { navigateTo } from "@k2b/ssr/nav";
import { AutocompleteEditor, Button, Chart, confirmDiscardIfDirty, DataTable, highlightSql, prompts, Tabs, TextInput } from "@k2b/ui";
import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { usePulseMessages } from "../use-messages";
import { buildPulseWorkspaceHref, readWorkspacePathState } from "./routes";
import SavedQueriesView from "./SavedQueriesView";
import { createSqlConsoleController, sqlConsoleInitialState } from "./sql-console-controller";
import { readSqlDraftHistory, sqlDraftHistoryState } from "./sql-draft-history";
import { sqlResultChart } from "./sql-result-chart";
import type { PulseWorkspaceProps } from "./types";

const EXAMPLE_SQL =
  "SELECT toStartOfInterval(ts, toIntervalSecond(:bucket), :base_tz) AS time, count() AS events\nFROM events\nWHERE ts >= now() - INTERVAL 1 DAY\nGROUP BY time\nORDER BY time";
export default function SqlConsoleView(props: {
  base: { id: string; name: string };
  route: PulseWorkspaceProps["initialRouteState"];
  snapshot: PulseWorkspaceProps["initialSql"];
  canWrite: boolean;
}) {
  const t = usePulseMessages();
  const lifetime = new AbortController();
  onCleanup(() => lifetime.abort());
  const [tab, setTab] = createSignal<"console" | "saved">("console");
  const [linkTooLong, setLinkTooLong] = createSignal(false);
  const [visibleRows, setVisibleRows] = createSignal(100);
  const parameterInputs = new Map<string, HTMLInputElement | HTMLTextAreaElement>();
  const controller = createSqlConsoleController({
    base: props.base,
    initial: sqlConsoleInitialState(props.route, props.snapshot),
    onRouteChange: (state) => {
      // Editing is not navigation: retain the mounted editor, caret and run.
      const settings = readWorkspacePathState(window.location.href, props.base.id).settings;
      const route = { ...state, settings };
      const href = buildPulseWorkspaceHref({ baseId: props.base.id, state: route });
      setLinkTooLong(state.sql !== undefined && !new URL(href, window.location.origin).searchParams.has("sql"));
      window.history.replaceState(sqlDraftHistoryState(window.history.state, props.base.id, route), "", href);
    },
    onSaveAsRequested: () => saveAs(),
    onAssistantLaunched: (launch) => navigateTo(launch.href),
    focusParameter: (name) => parameterInputs.get(name)?.focus(),
  });
  const c = controller;
  onMount(() => {
    const draft = readSqlDraftHistory(window.history.state, props.base.id, window.location.href);
    if (!draft) return;
    if (draft.sql !== undefined) c.setSql(draft.sql);
    for (const [name, value] of Object.entries(draft.params ?? {})) c.setParameter(name, value);
  });
  const band = () => c.statusBand();
  const chart = createMemo(() => {
    const result = c.lastResult();
    return result ? sqlResultChart(result) : null;
  });
  const markedLine = () => {
    const state = c.state();
    return state.kind === "error" ? state.details.line : undefined;
  };
  const title = () => `${c.chosenQuery()?.name ?? t().sqlNewQuery} · ${props.base.name}`;
  const saveAs = async () => {
    const value = await prompts.form({
      title: t().sqlSaveAs,
      signal: lifetime.signal,
      fields: { name: { type: "text", label: t().sqlQueryName, required: true } },
    });
    if (value?.name) await c.saveAs(value.name);
  };
  const remove = async () => {
    if (await prompts.confirm(t().sqlDeleteQuery, { title: c.chosenQuery()?.name, variant: "danger", signal: lifetime.signal }))
      await c.delete();
  };
  const example = async () => {
    if (!(await confirmDiscardIfDirty(c.hasUnsavedChanges)) || lifetime.signal.aborted) return;
    c.setSql(EXAMPLE_SQL);
    c.setParameter("bucket", "1h");
  };
  return (
    <section class="flex min-w-0 flex-1 flex-col gap-3" aria-label={title()}>
      <header class="flex flex-wrap items-center justify-between gap-2">
        <div class="min-w-0">
          <h1 class="truncate text-lg font-semibold text-primary">{title()}</h1>
        </div>
        <Button variant="secondary" disabled={c.assistantState() === "launching"} onClick={() => void c.launchAssistant()}>
          <i class="ti ti-sparkles" aria-hidden="true" />
          {t().sqlAskAssistant}
        </Button>
      </header>
      <Tabs
        value={tab}
        onValueChange={setTab}
        ariaLabel="SQL"
        options={[
          { value: "console", label: t().sqlConsole },
          { value: "saved", label: t().sqlSavedQueries },
        ]}
      />
      <Show
        when={tab() === "console"}
        fallback={
          <SavedQueriesView
            base={props.base}
            onSelect={async (query) => {
              if (!(await confirmDiscardIfDirty(c.hasUnsavedChanges)) || lifetime.signal.aborted) return;
              c.loadSaved(query);
              setTab("console");
            }}
          />
        }
      >
        <div data-sql-region="editor" class="min-w-0">
          <AutocompleteEditor
            aria-label="SQL"
            value={c.sql}
            onValueChange={c.setSql}
            highlight={highlightSql}
            lineNumbers
            markedLine={markedLine()}
            lines={6}
            onSubmit={() => void c.run()}
            placeholder="SELECT …"
          />
        </div>
        <div data-sql-region="parameters" class="flex h-20 shrink-0 flex-wrap items-start gap-3 overflow-auto">
          <For each={c.parameterNames()}>
            {(name) => {
              onCleanup(() => parameterInputs.delete(name));
              return (
                <div class="w-44 max-w-full">
                  <TextInput
                    label={`:${name}`}
                    value={() => c.parameterValues()[name] ?? ""}
                    onValueChange={(value) => c.setParameter(name, value)}
                    ref={(element) => parameterInputs.set(name, element)}
                    error={() => {
                      const state = c.state();
                      return state.kind === "error" && state.details.parameterName === name ? t().sqlParameterMissing : undefined;
                    }}
                  />
                </div>
              );
            }}
          </For>
        </div>
        <div data-sql-region="toolbar" class="flex h-20 shrink-0 flex-wrap content-start items-center gap-2 overflow-auto sm:h-10">
          <Button
            class="min-w-32"
            disabled={c.state().kind !== "running" && !c.canRun()}
            onClick={() => void (c.state().kind === "running" ? c.cancel() : c.run())}
          >
            <i class={c.state().kind === "running" ? "ti ti-player-stop" : "ti ti-player-play"} aria-hidden="true" />
            {c.state().kind === "running" ? t().sqlCancel : t().sqlRun}
          </Button>
          <span class="text-xs text-dimmed">⌘ / Ctrl ↵</span>
          <Show when={props.canWrite}>
            <Show when={c.chosenQuery()}>
              <Button variant="secondary" disabled={!c.canSave()} onClick={() => void c.save()}>
                {t().save}
              </Button>
            </Show>
            <Button variant="secondary" disabled={!c.canSave()} onClick={() => void saveAs()}>
              {t().sqlSaveAs}
            </Button>
            <Show when={c.chosenQuery()}>
              <Button variant="ghost" disabled={c.saving()} onClick={() => void remove()}>
                {t().sqlDeleteQuery}
              </Button>
            </Show>
          </Show>
        </div>
        <p
          data-sql-region="limits"
          class="h-24 shrink-0 overflow-auto text-xs leading-5 text-secondary sm:h-12"
          classList={{
            "text-error": (() => {
              const state = c.state();
              return state.kind === "error" && ["MEMORY_LIMIT", "TIME_LIMIT"].includes(state.code);
            })(),
          }}
        >
          {c.limitsLine() || c.inputBytes()}
          <Show when={linkTooLong()}>
            <span class="block text-warning">{t().sqlLinkTooLong}</span>
          </Show>
        </p>
        <div
          data-sql-region="status"
          role="status"
          aria-live="polite"
          class="flex h-28 shrink-0 sm:h-16 items-start justify-between gap-3 overflow-auto rounded-lg bg-muted p-3 text-sm"
          data-tone={band().kind}
        >
          <span>{band().message}</span>
          <Show when={band().action}>
            {(action) => (
              <Button variant="secondary" size="sm" disabled={action().kind === "retry" && !c.canRun()} onClick={() => void action().run()}>
                {action().label}
              </Button>
            )}
          </Show>
        </div>
        <div data-sql-region="result" class="h-96 min-w-0 shrink-0 overflow-auto">
          <Show
            when={c.lastResult()}
            fallback={
              <div class="flex min-h-80 flex-col items-center justify-center gap-3 text-center text-secondary">
                <p>{t().sqlEmptyHint}</p>
                <Button variant="secondary" onClick={example}>
                  {t().sqlInsertExample}
                </Button>
              </div>
            }
          >
            {(result) => (
              <>
                <div class="min-h-60">
                  {(() => {
                    const value = chart();
                    if (!value) return null;
                    if (value.kind === "none")
                      return (
                        <p class="py-4 text-xs text-secondary">
                          {
                            {
                              "no-time-column": t().sqlNoTimeColumn,
                              "no-numeric-column": t().sqlNoNumericColumn,
                              "no-rows": t().sqlNoRows,
                            }[value.reason]
                          }
                        </p>
                      );
                    return (
                      <>
                        <Chart {...value.chart} style={{ height: "12rem" }} />
                        <Show when={value.truncated}>
                          <p class="text-xs text-secondary">
                            {t().sqlChartCut({
                              seriesShown: String(value.cut.seriesShown),
                              seriesTotal: String(value.cut.seriesTotal),
                              pointsShown: String(value.cut.pointsShown),
                              pointsTotal: String(value.cut.pointsTotal),
                            })}{" "}
                            · {t().sqlChartCutHint}
                          </p>
                        </Show>
                      </>
                    );
                  })()}
                </div>
                <DataTable
                  surface="plain"
                  rows={result().rows.slice(0, visibleRows())}
                  columns={result().columns.map((column, index) => ({
                    id: String(index),
                    header: column.name,
                    subtitle: column.type,
                    value: (row: unknown[]) => row[index],
                  }))}
                  ariaLabel={t().sqlResultTable}
                  hasMore={visibleRows() < result().rows.length}
                  onLoadMore={() => setVisibleRows((count) => count + 100)}
                  scrollClass="max-h-96"
                />
              </>
            )}
          </Show>
        </div>
      </Show>
    </section>
  );
}
