import { navigateTo } from "@k2b/ssr/nav";
import {
  AutocompleteEditor,
  Button,
  Chart,
  confirmDiscardIfDirty,
  DataTable,
  type DataTableColumn,
  highlightSql,
  Kbd,
  prompts,
  Skeleton,
  StatusBadge,
  Tabs,
  TextInput,
  useLocale,
} from "@k2b/ui";
import { createEffect, createMemo, createSignal, createUniqueId, For, on, onCleanup, onMount, Show } from "solid-js";
import { usePulseMessages } from "../use-messages";
import { buildPulseWorkspaceHref, readWorkspacePathState } from "./routes";
import SavedQueriesView from "./SavedQueriesView";
import { createSqlConsoleController, type SqlStatusBand, sqlConsoleInitialState } from "./sql-console-controller";
import { readSqlDraftHistory, sqlDraftHistoryState } from "./sql-draft-history";
import { SQL_CHART_MAX_POINTS, SQL_CHART_MAX_SERIES, sqlResultChart } from "./sql-result-chart";
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
  const locale = useLocale();
  const lifetime = new AbortController();
  onCleanup(() => lifetime.abort());
  const [tab, setTab] = createSignal<"console" | "saved">("console");
  const [linkTooLong, setLinkTooLong] = createSignal(false);
  const [visibleRows, setVisibleRows] = createSignal(100);
  const missingErrorId = createUniqueId();
  const parameterChips = new Map<string, HTMLDivElement>();
  let parameterRow: HTMLDivElement | undefined;
  const parameterInputs = new Map<string, HTMLInputElement | HTMLTextAreaElement>();
  const focusParameter = (name: string) => {
    const input = parameterInputs.get(name);
    input?.focus({ preventScroll: true });
    input?.scrollIntoView({ block: "nearest", inline: "nearest" });
  };
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
    focusParameter,
  });
  const c = controller;
  onMount(() => {
    const draft = readSqlDraftHistory(window.history.state, props.base.id, window.location.href);
    if (!draft) return;
    if (draft.sql !== undefined) c.setSql(draft.sql);
    for (const [name, value] of Object.entries(draft.params ?? {})) c.setParameter(name, value);
  });
  const band = () => c.statusBand();
  const running = () => c.state().kind === "running";
  const runOrCancel = () => void (running() ? c.cancel() : c.run());
  const missing = createMemo(c.missingParameter);
  // Reveal only the horizontal parameter strip; a failed run never takes focus.
  createEffect(
    on([tab, () => missing()?.name], ([activeTab, name]) => {
      if (activeTab !== "console") return;
      const chip = name ? parameterChips.get(name) : undefined;
      if (!chip || !parameterRow) return;
      const bounds = parameterRow.getBoundingClientRect();
      const target = chip.getBoundingClientRect();
      const left = target.left < bounds.left ? target.left - bounds.left : target.right > bounds.right ? target.right - bounds.right : 0;
      parameterRow.scrollBy({ left, behavior: "instant" });
    }),
  );
  const limitColor = (kind: string) => {
    const state = c.state();
    const code = state.kind === "error" ? state.code : "";
    if (
      (kind === "memory" && code === "MEMORY_LIMIT") ||
      (kind === "time" && code === "TIME_LIMIT") ||
      (kind === "result" && code === "RESULT_TOO_LARGE")
    )
      return "var(--k2b-danger-text)";
    if (
      (kind === "result" && c.state().kind === "ok" && c.lastResult()?.truncated) ||
      (kind === "queue" && ["BUSY", "QUEUE_FULL"].includes(code)) ||
      (kind === "quota" && c.quotaBlocked())
    )
      return "var(--k2b-warning-text)";
    return undefined;
  };
  const chart = createMemo(() => {
    const result = c.lastResult();
    return result ? sqlResultChart(result, locale()) : null;
  });
  // An exhausted quota does not erase the successful last permitted run.
  const displayedResult = () => (c.state().kind === "ok" ? c.lastResult() : null);
  const chartBudget = () => (Boolean(displayedResult()) || running()) && chart()?.kind === "chart";
  const toneColor = (tone: SqlStatusBand["kind"]) =>
    tone === "error" ? "var(--k2b-danger-text)" : tone === "warning" ? "var(--k2b-warning-text)" : "var(--k2b-text)";
  const recoveryDisabled = (action: NonNullable<SqlStatusBand["action"]>) => {
    if (action.kind === "retry") return !c.canRun();
    if (action.kind === "retry-save" || action.kind === "save-as") return !props.canWrite || !c.canSave();
    if (action.kind === "retry-delete") return !props.canWrite || c.saving();
    if (action.kind === "reload-saved") return c.saving();
    if (action.kind === "retry-limits") return c.limitsLoading();
    if (action.kind === "retry-assistant") return c.assistantState() === "launching";
    return false;
  };
  const Recovery = (props: { band: SqlStatusBand }) => (
    <Show when={props.band.action}>
      {(action) => (
        <Button variant="subtle" size="sm" wrap disabled={recoveryDisabled(action())} onClick={() => void action().run()}>
          <i class="ti ti-refresh" aria-hidden="true" />
          {action().label}
        </Button>
      )}
    </Show>
  );
  const Diagnosis = (props: { band: SqlStatusBand }) => (
    <div class="flex max-w-[680px] flex-col items-start gap-1.5 py-2.5 text-sm [overflow-wrap:anywhere]">
      <h2 class="text-base font-semibold" style={{ color: toneColor(props.band.diagnosis?.kind ?? props.band.kind) }}>
        {props.band.diagnosis?.title ?? props.band.title ?? props.band.message}
      </h2>
      <Show when={props.band.diagnosis || (props.band.title && props.band.message !== props.band.title)}>
        <p class="text-secondary">{props.band.diagnosis?.message ?? props.band.message}</p>
      </Show>
      <Show when={props.band.action}>
        <div class="mt-1.5 flex flex-wrap gap-2">
          <Recovery band={props.band} />
        </div>
      </Show>
    </div>
  );
  const runDiagnosis = () => {
    const state = c.state();
    // Missing owns its separately named target below. Quota owns the reset time.
    return state.kind === "error" && !(state.code === "PARAMETER_MISSING" && missing()) && !(state.code === "QUOTA" && c.quotaBlocked())
      ? c.runErrorBand()
      : null;
  };
  const assistantDiagnosis = () => (c.assistantState() === "failed" ? c.assistantBand() : null);
  const noDiagnostics = () =>
    !missing() && !runDiagnosis() && !c.quotaBand() && !c.saveErrorBand() && !assistantDiagnosis() && !c.limitsErrorBand();
  const formatCount = (value: number) => new Intl.NumberFormat(locale(), { maximumFractionDigits: 0 }).format(value);
  const markedLine = () => {
    const state = c.state();
    return state.kind === "error" ? state.details.line : undefined;
  };
  const title = () => `${c.chosenQuery()?.name ?? t().sqlNewQuery} · ${props.base.name}`;
  const saveAs = async () => {
    if (!props.canWrite || !c.canSave()) return;
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
      <h1 class="sr-only">{title()}</h1>
      <Tabs
        value={tab}
        onValueChange={setTab}
        ariaLabel="SQL"
        trailing={
          <Button variant="ai" disabled={c.assistantState() === "launching"} onClick={() => void c.launchAssistant()}>
            <i class="ti ti-sparkles" aria-hidden="true" />
            {t().sqlAskAssistant}
          </Button>
        }
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
            onBackToConsole={() => setTab("console")}
            onSelect={async (query) => {
              if (!(await confirmDiscardIfDirty(c.hasUnsavedChanges)) || lifetime.signal.aborted) return;
              c.loadSaved(query);
              setTab("console");
            }}
          />
        }
      >
        {/* Match the existing k2b-app-area container, not a viewport or sidebar breakpoint. */}
        <div class="w-full min-w-0 max-w-[1120px]">
          <div
            data-sql-region="editor"
            class="min-w-0 rounded-xl bg-(--k2b-surface-muted) focus-within:shadow-[0_0_0_2px_var(--k2b-action)]"
            style={{
              "--k2b-code-keyword": "light-dark(#1e40af, #a5b8f3)",
              "--k2b-code-string": "light-dark(#047857, #6ee7b7)",
              "--k2b-code-number": "light-dark(#b45309, #fcd34d)",
              "--k2b-code-parameter": "light-dark(#7c3aed, #c4b5fd)",
            }}
            classList={{ "opacity-80": running() }}
          >
            <div
              data-sql-region="editor-head"
              class="flex h-9 items-center gap-2.5 overflow-hidden whitespace-nowrap px-3 text-[12.5px] text-dimmed"
            >
              {/* These are public SQL identifiers; the badge only identifies the unchanged example. */}
              <Show when={c.sql() === EXAMPLE_SQL}>
                <span class="inline-flex h-[22px] items-center rounded-md bg-[color-mix(in_srgb,var(--k2b-warning-500)_18%,transparent)] px-2 text-xs font-semibold text-(--k2b-warning-text)">
                  {t().sqlExampleLabel}
                </span>
              </Show>
              <span class="min-w-0 truncate" classList={{ "@max-[760px]/k2b-app-area:hidden": c.sql() === EXAMPLE_SQL }}>
                {t().sqlTables({ tables: "samples, rollups, series, events, states, sources" })}
              </span>
              <span class="ml-auto flex shrink-0 items-center gap-1 @max-[760px]/k2b-app-area:hidden">
                <Kbd keys="meta+enter" platform="apple" /> / <Kbd keys="ctrl+enter" platform="other" />
                {t().sqlRun}
              </span>
            </div>
            <div
              data-sql-region="code"
              class="h-[232px] min-w-0 font-mono text-[13px] leading-5 @max-[760px]/k2b-app-area:h-[220px] @max-[760px]/k2b-app-area:text-xs"
            >
              <AutocompleteEditor
                aria-label="SQL"
                value={c.sql}
                onValueChange={c.setSql}
                highlight={highlightSql}
                variant="embedded"
                fill
                lineNumbers
                markedLine={markedLine()}
                readOnly={running()}
                onSubmit={runOrCancel}
                placeholder="SELECT …"
              />
            </div>
            <div
              data-sql-region="parameters"
              class="flex h-9 min-w-0 items-center gap-2.5 px-3 text-[12.5px] text-dimmed @max-[760px]/k2b-app-area:h-[66px] @max-[760px]/k2b-app-area:flex-wrap @max-[760px]/k2b-app-area:content-center @max-[760px]/k2b-app-area:gap-y-1 @max-[760px]/k2b-app-area:py-1"
            >
              <div
                ref={parameterRow}
                data-sql-parameter-strip
                class="relative flex h-full min-w-0 flex-1 items-center gap-2 overflow-x-auto overflow-y-hidden [scrollbar-width:none] @max-[760px]/k2b-app-area:h-[30px] @max-[760px]/k2b-app-area:basis-full"
              >
                <For each={c.parameterNames()} fallback={<span class="whitespace-nowrap">{t().sqlNoParameters}</span>}>
                  {(name) => {
                    onCleanup(() => {
                      parameterInputs.delete(name);
                      parameterChips.delete(name);
                    });
                    return (
                      <div ref={(element) => parameterChips.set(name, element)} class="shrink-0">
                        <TextInput
                          variant="compact"
                          monospace
                          prefix={<span class="font-mono! font-semibold text-(--k2b-code-parameter)">:{name}</span>}
                          aria-label={`:${name}`}
                          value={() => c.parameterValues()[name] ?? ""}
                          size={Math.max(9, (c.parameterValues()[name] ?? "").length + 1)}
                          onValueChange={(value) => c.setParameter(name, value)}
                          ref={(element) => parameterInputs.set(name, element)}
                          readOnly={running()}
                          spellcheck={false}
                          autocomplete="off"
                          autocapitalize="none"
                          autocorrect="off"
                          placeholder={t().sqlParameterFocus}
                          externalErrorId={missingErrorId}
                          error={() => (missing()?.name === name ? missing()?.message : undefined)}
                          onSubmit={runOrCancel}
                        />
                      </div>
                    );
                  }}
                </For>
              </div>
              <span data-sql-helper-hint class="min-w-0 overflow-hidden whitespace-nowrap">
                {t().sqlHelperHint}
              </span>
            </div>
          </div>
          <div
            data-sql-region="toolbar"
            class="flex min-h-14 items-center gap-2 @max-[760px]/k2b-app-area:flex-wrap @max-[760px]/k2b-app-area:gap-y-1.5 @max-[760px]/k2b-app-area:pt-2.5 @max-[760px]/k2b-app-area:pb-1.5"
          >
            <Button
              class="h-9 min-w-[132px] shrink-0 @max-[760px]/k2b-app-area:min-w-32"
              variant={running() ? "subtle" : "primary"}
              aria-keyshortcuts="Meta+Enter Control+Enter"
              disabled={!running() && !c.canRun()}
              onClick={runOrCancel}
            >
              {/* Both labels always determine the same width, including translated labels. */}
              <span class="inline-grid">
                <span
                  class="col-start-1 row-start-1 inline-flex items-center justify-center gap-[7px]"
                  classList={{ invisible: running() }}
                  aria-hidden={running()}
                >
                  <i class="ti ti-player-play" aria-hidden="true" />
                  {t().sqlRun}
                </span>
                <span
                  class="col-start-1 row-start-1 inline-flex items-center justify-center gap-[7px]"
                  classList={{ invisible: !running() }}
                  aria-hidden={!running()}
                >
                  <i class="ti ti-player-stop" aria-hidden="true" />
                  {t().sqlCancel}
                </span>
              </span>
            </Button>
            <Show when={props.canWrite}>
              <Show when={c.chosenQuery()}>
                <Button class="h-9" variant="ghost" disabled={!c.canSave()} onClick={() => void c.save()} aria-label={t().save}>
                  <i class="ti ti-bookmark" aria-hidden="true" />
                  <span class="@max-[760px]/k2b-app-area:hidden">{t().save}</span>
                </Button>
              </Show>
              <Button class="h-9" variant="ghost" disabled={!c.canSave()} onClick={() => void saveAs()} aria-label={t().sqlSaveAs}>
                <i class={c.chosenQuery() ? "ti ti-bookmark-plus" : "ti ti-bookmark"} aria-hidden="true" />
                <span class="@max-[760px]/k2b-app-area:hidden">{t().sqlSaveAs}</span>
              </Button>
              <Show when={c.chosenQuery()}>
                <Button class="h-9" variant="ghost" disabled={c.saving()} onClick={() => void remove()} aria-label={t().sqlDeleteQuery}>
                  <i class="ti ti-trash" aria-hidden="true" />
                  <span class="@max-[760px]/k2b-app-area:hidden">{t().sqlDeleteQuery}</span>
                </Button>
              </Show>
            </Show>
            <span class="ml-auto whitespace-nowrap text-[12.5px] tabular-nums text-dimmed @max-[760px]/k2b-app-area:ml-0 @max-[760px]/k2b-app-area:basis-full">
              <span data-sql-input="bytes" style={{ color: c.inputBytesOverLimit() ? "var(--k2b-danger-text)" : undefined }}>
                {c.inputBytes()}
              </span>
              {" · "}
              <span data-sql-input="parameters" style={{ color: c.inputParametersOverLimit() ? "var(--k2b-danger-text)" : undefined }}>
                {c.inputParameters()}
              </span>
            </span>
          </div>
          <p
            data-sql-region="limits"
            class="mb-1 flex min-h-[22px] items-start gap-2 text-[12.5px] leading-5 text-dimmed @max-[760px]/k2b-app-area:min-h-[70px] @max-[760px]/k2b-app-area:text-xs"
          >
            <i class="ti ti-gauge mt-px text-[15px]" aria-hidden="true" />
            <span class="min-w-0">
              <For each={c.limitSegments()}>
                {(segment) => (
                  <>
                    <span data-sql-limit={segment.kind} style={{ color: limitColor(segment.kind) }}>
                      {segment.text}
                    </span>
                    {segment.separator}
                  </>
                )}
              </For>
            </span>
          </p>
          <div
            data-sql-region="status"
            data-tone={band().kind}
            class="mt-1 mb-1.5 flex h-10 items-center gap-2.5 text-[13px] text-dimmed @max-[760px]/k2b-app-area:h-[52px]"
          >
            <span class="mt-0.5 flex w-3.5 shrink-0 justify-center" aria-hidden="true">
              <StatusBadge class="gap-0!" tone={band().kind} variant={band().kind === "running" ? "text" : "dot"} label="" />
            </span>
            <div
              role="group"
              tabIndex={0}
              aria-label={t().sqlConsole}
              class="max-h-full min-h-0 min-w-0 flex-1 overflow-auto [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-(--k2b-focus-ring)"
            >
              <span role="status" aria-live="polite" aria-atomic="true">
                <strong class="font-semibold" style={{ color: toneColor(band().kind) }}>
                  {band().kind === "ok" && displayedResult()
                    ? t().sqlResultRows({ count: displayedResult()!.rowCount, formatted: formatCount(displayedResult()!.rowCount) })
                    : c.state().kind === "empty" && band().kind === "neutral"
                      ? t().sqlReady
                      : (band().title ?? band().message)}
                </strong>
                <Show
                  when={band().kind === "ok" && displayedResult()}
                  fallback={
                    <Show when={band().title && band().message !== band().title}>
                      <span>
                        {" · "}
                        {band().message}
                      </span>
                    </Show>
                  }
                >
                  <span>
                    {" · "}
                    {t().sqlResultStats({
                      elapsed: new Intl.NumberFormat(locale(), { maximumFractionDigits: 1 }).format(displayedResult()!.stats.elapsedMs),
                      read: new Intl.NumberFormat(locale(), { maximumFractionDigits: 1 }).format(
                        displayedResult()!.stats.readBytes / 1024 ** 2,
                      ),
                    })}
                  </span>
                </Show>
                <Show when={c.state().kind === "empty" && band().kind === "neutral"}>
                  <span>
                    {" · "}
                    {t().sqlEmptyDetail}
                  </span>
                </Show>
                <Show when={missing() && band().action?.kind !== "focus-parameter"}>
                  <span class="block text-(--k2b-danger-text)">
                    {t().sqlParameterMissing}
                    {" · "}
                    {t().sqlMissingParameter({ name: missing()!.name })}
                  </span>
                </Show>
              </span>
              <Show when={running()}>
                <span role="timer" aria-live="off">
                  {" · "}
                  {c.runningElapsedText()}
                </span>
              </Show>
            </div>
          </div>
          <div
            data-sql-region="result"
            aria-busy={running() || undefined}
            class="min-h-[360px] min-w-0"
            classList={{ "min-h-[600px]! @max-[760px]/k2b-app-area:min-h-[560px]!": chartBudget() }}
          >
            {/* The one console status above owns loading announcements. Shapes encode only known geometry. */}
            <Show when={running()}>
              <div aria-hidden="true">
                <Show
                  when={chartBudget()}
                  fallback={
                    <div class="mb-2.5 flex h-[22px] items-center">
                      <Skeleton class="h-3.5 w-[30%]" />
                    </div>
                  }
                >
                  <div class="mb-3.5">
                    <div class="flex min-h-[22px] items-center @max-[760px]/k2b-app-area:min-h-9">
                      <Skeleton class="h-3.5 w-[38%]" />
                    </div>
                    <div class="flex h-[30px] items-center">
                      <Skeleton class="h-3.5 w-[22%]" />
                    </div>
                    <Skeleton class="h-[200px] @max-[760px]/k2b-app-area:h-[180px]" />
                  </div>
                </Show>
                <div style={{ height: `${c.lastResult() ? Math.min(38 + c.lastResult()!.rows.length * 36, 326) : 326}px` }}>
                  <Skeleton class="h-full w-full" />
                </div>
              </div>
            </Show>
            <div class="flex max-w-[680px] flex-col items-start gap-1.5 py-2.5 text-sm [overflow-wrap:anywhere]" hidden={!missing()}>
              <h2 class="text-base font-semibold text-(--k2b-danger-text)">{t().sqlNotStarted}</h2>
              <p id={missingErrorId} class="text-secondary">
                {missing()?.message}
              </p>
              <div class="mt-1.5 flex flex-wrap gap-2">
                <Button variant="subtle" size="sm" onClick={() => focusParameter(missing()?.name ?? "")}>
                  <i class="ti ti-forms" aria-hidden="true" />
                  {t().sqlParameterFocus}
                </Button>
              </div>
            </div>
            <Show when={!running()}>
              <Show when={runDiagnosis()}>{(diagnosis) => <Diagnosis band={diagnosis()} />}</Show>
              <Show when={c.quotaBand()}>{(diagnosis) => <Diagnosis band={diagnosis()} />}</Show>
            </Show>
            <Show when={c.saveErrorBand()}>{(diagnosis) => <Diagnosis band={diagnosis()} />}</Show>
            <Show when={assistantDiagnosis()}>{(diagnosis) => <Diagnosis band={diagnosis()} />}</Show>
            {/* Quota already contains the complete usage-refresh diagnosis and its own retry. */}
            <Show when={!c.quotaBlocked() && c.limitsErrorBand()}>{(diagnosis) => <Diagnosis band={diagnosis()} />}</Show>
            <Show when={linkTooLong()}>
              <p class="max-w-[680px] py-2.5 text-sm text-(--k2b-warning-text)">{t().sqlLinkTooLong}</p>
            </Show>
            <Show when={!running() && !displayedResult() && noDiagnostics()}>
              <div class="max-w-[680px] py-2.5 text-sm text-dimmed">
                <p>{t().sqlEmptyHint}</p>
                <div class="mt-1.5 flex flex-wrap gap-2">
                  <Button variant="subtle" onClick={example}>
                    <i class="ti ti-file-code" aria-hidden="true" />
                    {t().sqlInsertExample}
                  </Button>
                  <Button variant="ai" disabled={c.assistantState() === "launching"} onClick={() => void c.launchAssistant()}>
                    <i class="ti ti-sparkles" aria-hidden="true" />
                    {t().sqlAskAssistant}
                  </Button>
                </div>
              </div>
            </Show>
            <Show when={displayedResult()}>
              {(result) => (
                <>
                  {(() => {
                    const value = chart();
                    if (!value) return null;
                    if (value.kind === "none")
                      return (
                        <p class="mb-2.5 flex min-h-[22px] items-start gap-2 text-[13px] text-dimmed">
                          <i class="ti ti-chart-line text-base" aria-hidden="true" />
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
                      <div class="mb-3.5">
                        <p class="min-h-[22px] text-xs text-dimmed @max-[760px]/k2b-app-area:min-h-9">
                          <span style={{ color: value.truncated ? "var(--k2b-warning-text)" : undefined }}>
                            {value.truncated
                              ? t().sqlChartCut({
                                  seriesShown: formatCount(value.cut.seriesShown),
                                  seriesTotal: formatCount(value.cut.seriesTotal),
                                  pointsShown: formatCount(value.cut.pointsShown),
                                  pointsTotal: formatCount(value.cut.pointsTotal),
                                })
                              : t().sqlChartMeta({
                                  column: value.xColumn,
                                  series: value.cut.seriesShown,
                                  points: value.cut.pointsShown,
                                  formattedPoints: formatCount(value.cut.pointsShown),
                                  maxSeries: formatCount(SQL_CHART_MAX_SERIES),
                                  maxPoints: formatCount(SQL_CHART_MAX_POINTS),
                                })}
                          </span>
                          <Show when={value.truncated}>
                            <span>
                              {" · "}
                              {t().sqlChartCutHint}
                            </span>
                          </Show>
                        </p>
                        <Chart {...value.chart} legendPlacement="top-start" class="h-[230px] @max-[760px]/k2b-app-area:h-[210px]" />
                      </div>
                    );
                  })()}
                  <DataTable
                    surface="plain"
                    density="compact"
                    class="w-fit max-w-full rounded-[10px]!"
                    tableClass="w-max! border-separate! border-spacing-0!"
                    rowClass="group/pulse-result-row border-0!"
                    cellContentClass="whitespace-nowrap font-mono!"
                    rows={result().rows.slice(0, visibleRows())}
                    columns={result().columns.map(
                      (column, index): DataTableColumn<unknown[]> => ({
                        id: String(index),
                        header: column.name,
                        subtitle: <span class="font-mono! text-[11px] font-normal text-dimmed">{column.type}</span>,
                        value: (row: unknown[]) => row[index],
                        align: /^(?:U?Int\d+|Float\d+|Decimal(?:\d+)?(?:\([^)]*\))?)$/.test(column.type.replace(/^Nullable\((.*)\)$/, "$1"))
                          ? "right"
                          : "left",
                        nowrap: true,
                        headerClass:
                          "h-[38px]! px-3.5! py-0! text-[12.5px]! font-semibold! text-secondary! bg-(--k2b-surface) whitespace-nowrap",
                        cellClass:
                          "h-9! px-3.5! py-0! font-mono text-[12.5px] text-primary first:rounded-l-lg last:rounded-r-lg group-odd/pulse-result-row:bg-[color-mix(in_srgb,var(--k2b-surface-muted)_60%,transparent)]",
                      }),
                    )}
                    ariaLabel={t().sqlResultTable}
                    hasMore={visibleRows() < result().rows.length}
                    onLoadMore={() => setVisibleRows((count) => count + 100)}
                    scrollClass="max-h-[326px]"
                  />
                  <Show when={result().truncated}>
                    <p class="mt-2 text-xs text-dimmed">{t().sqlTableCut({ rows: formatCount(result().rowCount) })}</p>
                  </Show>
                </>
              )}
            </Show>
          </div>
        </div>
      </Show>
    </section>
  );
}
