import { navigateTo } from "@k2b/ssr/nav";
import { AutocompleteEditor, Chart, highlightSql, useLocale } from "@k2b/ui";
import { Band, Bar, Button, Canvas, Chip, Dialog, Empty, Field, Inline, Input, Notice, Pane, Section, Table, Text } from "@k2b/ui/v2";
import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import type { PulseBase } from "../../contracts";
import { usePulseMessages } from "../use-messages";
import { buildPulseWorkspaceHref, readWorkspacePathState, type WorkspaceRouteState } from "../workspace/routes";
import { createSqlConsoleController, type SqlStatusBand, sqlConsoleInitialState } from "../workspace/sql-console-controller";
import { readSqlDraftHistory, sqlDraftHistoryState } from "../workspace/sql-draft-history";
import { SQL_CHART_MAX_POINTS, SQL_CHART_MAX_SERIES, sqlResultChart } from "../workspace/sql-result-chart";
import type { PulseWorkspaceProps } from "../workspace/types";
import BaseFrame from "./BaseFrame";
import { useScreenMessages } from "./messages";

export const EXAMPLE_SQL =
  "SELECT toStartOfInterval(ts, toIntervalSecond(:bucket), :base_tz) AS time, count() AS events\nFROM events\nWHERE ts >= now() - INTERVAL 1 DAY\nGROUP BY time\nORDER BY time";
const ROWS_STEP = 100;
const NUMERIC = /^(?:U?Int\d+|Float\d+|Decimal(?:\d+)?(?:\([^)]*\))?)$/;

export type SqlScreenProps = {
  bases: PulseBase[];
  baseId: string;
  sourceCount: number;
  route: WorkspaceRouteState;
  snapshot: PulseWorkspaceProps["initialSql"];
  canWrite: boolean;
};

/**
 * The SQL console of a base on v2: the editor (a rich component of its own) in a canvas, its parameters as fields,
 * the run bar with the page's one primary "Run", then the outcome: diagnoses as notices, the chart and the table.
 * The draft lives in the address and the history entry, so reload and back keep it.
 */
export default function SqlScreen(props: SqlScreenProps) {
  const t = usePulseMessages();
  const words = useScreenMessages();
  const locale = useLocale();
  const lifetime = new AbortController();
  onCleanup(() => lifetime.abort());
  const base = () => ({ id: props.baseId, name: props.bases.find((entry) => entry.id === props.baseId)?.name ?? t().appName });
  const [linkTooLong, setLinkTooLong] = createSignal(false);
  const [visibleRows, setVisibleRows] = createSignal(ROWS_STEP);
  const [savingAs, setSavingAs] = createSignal(false);
  const parameterInputs = new Map<string, HTMLInputElement | HTMLTextAreaElement>();
  const focusParameter = (name: string) => {
    const input = parameterInputs.get(name);
    input?.focus({ preventScroll: true });
    input?.scrollIntoView({ block: "nearest" });
  };
  const c = createSqlConsoleController({
    base: base(),
    initial: sqlConsoleInitialState(props.route, props.snapshot),
    onRouteChange: (state) => {
      // Editing is not navigation: the editor, its caret and a running query stay.
      const settings = readWorkspacePathState(window.location.href, props.baseId).settings;
      const route = { ...state, settings };
      const href = buildPulseWorkspaceHref({ baseId: props.baseId, state: route });
      setLinkTooLong(state.sql !== undefined && !new URL(href, window.location.origin).searchParams.has("sql"));
      window.history.replaceState(sqlDraftHistoryState(window.history.state, props.baseId, route), "", href);
    },
    onSaveAsRequested: () => {
      setSavingAs(true);
    },
    onAssistantLaunched: (launch) => navigateTo(launch.href),
    focusParameter,
  });
  onMount(() => {
    const draft = readSqlDraftHistory(window.history.state, props.baseId, window.location.href);
    if (!draft) return;
    if (draft.sql !== undefined) c.setSql(draft.sql);
    for (const [name, value] of Object.entries(draft.params ?? {})) c.setParameter(name, value);
  });
  const running = () => c.state().kind === "running";
  const runOrCancel = () => {
    setVisibleRows(ROWS_STEP);
    void (running() ? c.cancel() : c.run());
  };
  const band = () => c.statusBand();
  const missing = createMemo(c.missingParameter);
  const result = () => (c.state().kind === "ok" ? c.lastResult() : null);
  const chart = createMemo(() => {
    const value = result();
    return value ? sqlResultChart(value, locale()) : null;
  });
  /** Why the result draws no chart, in words; null when it draws one or nothing ran. */
  const chartNote = () => {
    const value = chart();
    if (!value || value.kind !== "none") return null;
    return { "no-time-column": t().sqlNoTimeColumn, "no-numeric-column": t().sqlNoNumericColumn, "no-rows": t().sqlNoRows }[value.reason];
  };
  const drawn = () => {
    const value = chart();
    return value?.kind === "chart" && result() ? value : null;
  };
  const count = (value: number) => new Intl.NumberFormat(locale(), { maximumFractionDigits: 0 }).format(value);
  const decimal = (value: number) => new Intl.NumberFormat(locale(), { maximumFractionDigits: 1 }).format(value);
  const runDiagnosis = () => {
    const state = c.state();
    // Missing has its own notice below; quota owns the reset time.
    return state.kind === "error" && !(state.code === "PARAMETER_MISSING" && missing()) && !(state.code === "QUOTA" && c.quotaBlocked())
      ? c.runErrorBand()
      : null;
  };
  const diagnoses = () =>
    [
      running() ? null : runDiagnosis(),
      running() ? null : c.quotaBand(),
      c.saveErrorBand(),
      c.assistantState() === "failed" ? c.assistantBand() : null,
      c.quotaBlocked() ? null : c.limitsErrorBand(),
    ].filter((entry): entry is SqlStatusBand => entry !== null);
  const recoveryDisabled = (action: NonNullable<SqlStatusBand["action"]>) => {
    if (action.kind === "retry") return !c.canRun();
    if (action.kind === "retry-save" || action.kind === "save-as") return !props.canWrite || !c.canSave();
    if (action.kind === "retry-delete") return !props.canWrite || c.saving();
    if (action.kind === "reload-saved") return c.saving();
    if (action.kind === "retry-limits") return c.limitsLoading();
    if (action.kind === "retry-assistant") return c.assistantState() === "launching";
    return false;
  };
  /** The result's one statement: how many rows and what it cost, the state of the run, or what is ready. */
  const summary = () => {
    const value = result();
    if (band().kind === "ok" && value)
      return `${t().sqlResultRows({ count: value.rowCount, formatted: count(value.rowCount) })} · ${t().sqlResultStats({
        elapsed: decimal(value.stats.elapsedMs),
        read: decimal(value.stats.readBytes / 1024 ** 2),
      })}`;
    if (running()) return `${band().title ?? band().message} · ${c.runningElapsedText()}`;
    if (c.state().kind === "empty" && band().kind === "neutral") return `${t().sqlReady} · ${t().sqlEmptyDetail}`;
    return band().title && band().message !== band().title ? `${band().title} · ${band().message}` : (band().title ?? band().message);
  };
  const columns = createMemo(() =>
    (result()?.columns ?? []).map((column, index) => ({
      title: column.name,
      width: { min: 80, default: Math.min(320, Math.max(120, column.name.length * 9 + 40)) },
      align: NUMERIC.test(column.type.replace(/^Nullable\((.*)\)$/, "$1")) ? ("end" as const) : ("start" as const),
      // The console shows what the query returned, so numbers keep their raw digits (IDs, years, ports).
      cell: (row: unknown[]) => {
        const value = row[index];
        return value === null || value === undefined ? "NULL" : typeof value === "object" ? JSON.stringify(value) : String(value);
      },
    })),
  );
  const remove = async () => {
    const agreed = await Dialog.confirm({
      title: t().sqlDeleteQuery,
      description: c.chosenQuery()?.name,
      confirm: t().sqlDeleteQuery,
      cancel: words().cancel,
    });
    if (agreed && !lifetime.signal.aborted) await c.delete();
  };
  const example = async () => {
    if (c.hasUnsavedChanges()) {
      const agreed = await Dialog.confirm({ title: words().discard, confirm: words().discard, cancel: words().cancel });
      if (!agreed || lifetime.signal.aborted) return;
    }
    c.setSql(EXAMPLE_SQL);
    c.setParameter("bucket", "1h");
  };
  const askAssistant = {
    label: t().sqlAskAssistant,
    icon: "sparkles",
    disabled: c.assistantState() === "launching",
    onClick: () => void c.launchAssistant(),
  };

  return (
    <BaseFrame
      bases={props.bases}
      baseId={props.baseId}
      view="sql"
      sourceCount={props.sourceCount}
      more={[askAssistant]}
      end={
        <Button icon="sparkles" busy={c.assistantState() === "launching"} onClick={() => void c.launchAssistant()}>
          {t().sqlAskAssistant}
        </Button>
      }
    >
      <Pane
        label={`${c.chosenQuery()?.name ?? t().sqlNewQuery} · ${base().name}`}
        scrollKey="pulse-sql"
        status={
          <Bar
            start={
              <Inline>
                <Text weight="medium">{c.chosenQuery()?.name ?? t().sqlNewQuery}</Text>
                <Show when={c.hasUnsavedChanges() && c.chosenQuery()}>
                  <Text type="meta" muted>
                    {words().unsaved}
                  </Text>
                </Show>
                <Show when={c.sql() === EXAMPLE_SQL}>
                  <Chip status="warn">{t().sqlExampleLabel}</Chip>
                </Show>
              </Inline>
            }
            end={
              <Show when={props.canWrite}>
                <Show when={c.chosenQuery()}>
                  <Button variant="ghost" icon="bookmark" disabled={!c.canSave()} onClick={() => void c.save()}>
                    {t().save}
                  </Button>
                </Show>
                <Button
                  variant="ghost"
                  icon={c.chosenQuery() ? "bookmark-plus" : "bookmark"}
                  disabled={!c.canSave()}
                  onClick={() => setSavingAs(true)}
                >
                  {t().sqlSaveAs}
                </Button>
                <Show when={c.chosenQuery()}>
                  <Button variant="ghost" icon="trash" label={t().sqlDeleteQuery} disabled={c.saving()} onClick={() => void remove()} />
                </Show>
              </Show>
            }
          />
        }
      >
        {/* k2b-ui gap: no code editor in v2; the Autocomplete editor keeps its behaviour and draws inside a canvas. */}
        <Canvas label="SQL" height={232}>
          <AutocompleteEditor
            aria-label="SQL"
            value={c.sql}
            onValueChange={c.setSql}
            highlight={highlightSql}
            variant="embedded"
            fill
            lineNumbers
            markedLine={(() => {
              const state = c.state();
              return state.kind === "error" ? state.details.line : undefined;
            })()}
            readOnly={running()}
            onSubmit={runOrCancel}
            placeholder="SELECT …"
          />
        </Canvas>
        <Band>
          <Show
            when={c.parameterNames().length > 0}
            fallback={<Text type="meta" muted>{`${t().sqlNoParameters} · ${t().sqlHelperHint}`}</Text>}
          >
            <Field.Row>
              <For each={c.parameterNames()}>
                {(name) => {
                  onCleanup(() => parameterInputs.delete(name));
                  return (
                    <Field name={`param-${name}`} label={`:${name}`} error={missing()?.name === name ? missing()?.message : undefined}>
                      <Input
                        value={c.parameterValues()[name] ?? ""}
                        placeholder={t().sqlParameterFocus}
                        disabled={running()}
                        ref={(element) => parameterInputs.set(name, element)}
                        onInput={(value) => c.setParameter(name, value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.isComposing) {
                            event.preventDefault();
                            runOrCancel();
                          }
                        }}
                      />
                    </Field>
                  );
                }}
              </For>
            </Field.Row>
          </Show>
        </Band>
        <Bar
          start={
            <Inline>
              <Button
                variant={running() ? "secondary" : "primary"}
                icon={running() ? "player-stop" : "player-play"}
                disabled={!running() && !c.canRun()}
                onClick={runOrCancel}
              >
                {running() ? t().sqlCancel : t().sqlRun}
              </Button>
              <Text type="meta" muted>
                ⌘/Ctrl + Enter
              </Text>
            </Inline>
          }
          end={
            <Inline>
              <Text type="meta" tone={c.inputBytesOverLimit() ? "bad" : undefined} muted={!c.inputBytesOverLimit()}>
                {c.inputBytes()}
              </Text>
              <Text type="meta" tone={c.inputParametersOverLimit() ? "bad" : undefined} muted={!c.inputParametersOverLimit()}>
                {c.inputParameters()}
              </Text>
            </Inline>
          }
        />
        <Show when={missing()}>
          {(entry) => (
            <Notice
              tone="bad"
              icon="forms"
              title={t().sqlNotStarted}
              actions={[{ label: t().sqlParameterFocus, icon: "forms", onClick: () => focusParameter(entry().name) }]}
            >
              {entry().message}
            </Notice>
          )}
        </Show>
        <For each={diagnoses()}>
          {(diagnosis) => (
            <Notice
              tone={(diagnosis.diagnosis?.kind ?? diagnosis.kind) === "error" ? "bad" : "warn"}
              icon="alert-circle"
              title={diagnosis.diagnosis?.title ?? diagnosis.title ?? diagnosis.message}
              actions={
                diagnosis.action && !["cancel", "focus-parameter"].includes(diagnosis.action.kind)
                  ? [
                      {
                        label: diagnosis.action.label,
                        icon: "refresh",
                        disabled: recoveryDisabled(diagnosis.action),
                        onClick: () => void diagnosis.action?.run(),
                      },
                    ]
                  : undefined
              }
            >
              {diagnosis.diagnosis?.message ?? (diagnosis.title && diagnosis.message !== diagnosis.title ? diagnosis.message : "")}
            </Notice>
          )}
        </For>
        <Show when={linkTooLong()}>
          <Notice tone="warn" icon="link">
            {t().sqlLinkTooLong}
          </Notice>
        </Show>
        <Section icon="table" title={words().result} summary={summary()}>
          <Show
            when={result() || running()}
            fallback={
              <Show when={diagnoses().length === 0 && !missing()}>
                <Empty
                  icon="code"
                  text={t().sqlEmptyHint}
                  action={{ label: t().sqlInsertExample, icon: "file-code", onClick: () => void example() }}
                />
              </Show>
            }
          >
            <Show when={chartNote()}>
              {(note) => (
                <Text type="meta" muted>
                  {note()}
                </Text>
              )}
            </Show>
            <Table
              label={t().sqlResultTable}
              rows={running() ? [] : (result()?.rows.slice(0, visibleRows()) ?? [])}
              rowKey={(row) => String((result()?.rows ?? []).indexOf(row))}
              sticky
              loading={running() ? { rows: Math.min(8, Math.max(3, result()?.rows.length ?? 5)) } : undefined}
              empty={{ icon: "table", text: t().sqlNoRows }}
              phone={(row) => ({
                lines: [
                  String(row[0] ?? "NULL"),
                  columns()
                    .slice(1, 3)
                    .map((column) => column.cell(row))
                    .join(" · "),
                ],
              })}
              columns={columns()}
            />
          </Show>
        </Section>
        <Show when={result() && (visibleRows() < (result()?.rows.length ?? 0) || result()?.truncated)}>
          <Bar
            start={
              <Text type="meta" muted>
                {result()?.truncated
                  ? t().sqlTableCut({ rows: count(result()?.rowCount ?? 0) })
                  : words().rowsShown({
                      shown: count(Math.min(visibleRows(), result()?.rows.length ?? 0)),
                      total: count(result()?.rows.length ?? 0),
                    })}
              </Text>
            }
            end={
              <Show when={visibleRows() < (result()?.rows.length ?? 0)}>
                <Button icon="chevrons-down" onClick={() => setVisibleRows((value) => value + ROWS_STEP)}>
                  {words().loadMoreRows}
                </Button>
              </Show>
            }
          />
        </Show>
        <Show when={drawn()}>
          {(value) => (
            <Section
              icon="chart-line"
              title={words().chart}
              summary={
                value().truncated
                  ? `${t().sqlChartCut({
                      seriesShown: count(value().cut.seriesShown),
                      seriesTotal: count(value().cut.seriesTotal),
                      pointsShown: count(value().cut.pointsShown),
                      pointsTotal: count(value().cut.pointsTotal),
                    })} · ${t().sqlChartCutHint}`
                  : t().sqlChartMeta({
                      column: value().xColumn,
                      series: value().cut.seriesShown,
                      points: value().cut.pointsShown,
                      formattedPoints: count(value().cut.pointsShown),
                      maxSeries: count(SQL_CHART_MAX_SERIES),
                      maxPoints: count(SQL_CHART_MAX_POINTS),
                    })
              }
            >
              <Canvas label={words().chart} height={240}>
                <Chart {...value().chart} legendPlacement="top-start" style={{ height: "100%" }} />
              </Canvas>
            </Section>
          )}
        </Show>
        <Show when={c.limitSegments().length > 0}>
          <Band>
            <Inline>
              <For each={c.limitSegments()}>
                {(segment) => (
                  <Text type="meta" muted={!limitTone(segment.kind)} tone={limitTone(segment.kind)}>
                    {segment.text}
                  </Text>
                )}
              </For>
            </Inline>
          </Band>
        </Show>
      </Pane>
      <SaveAsDialog
        open={savingAs()}
        onOpenChange={setSavingAs}
        save={async (name) => {
          await c.saveAs(name);
        }}
      />
    </BaseFrame>
  );

  /** The limit a failed or cut run hit stands out: red when it stopped the run, orange when it cut or queued it. */
  function limitTone(kind: string): "bad" | "warn" | undefined {
    const state = c.state();
    const code = state.kind === "error" ? state.code : "";
    if (
      (kind === "memory" && code === "MEMORY_LIMIT") ||
      (kind === "time" && code === "TIME_LIMIT") ||
      (kind === "result" && code === "RESULT_TOO_LARGE")
    )
      return "bad";
    if (
      (kind === "result" && state.kind === "ok" && c.lastResult()?.truncated) ||
      (kind === "queue" && ["BUSY", "QUEUE_FULL"].includes(code)) ||
      (kind === "quota" && c.quotaBlocked())
    )
      return "warn";
    return undefined;
  }
}

/** The name of a new saved query. */
function SaveAsDialog(props: { open: boolean; onOpenChange: (open: boolean) => void; save: (name: string) => Promise<void> }) {
  const t = usePulseMessages();
  const words = useScreenMessages();
  const [name, setName] = createSignal("");
  const [tried, setTried] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const close = (open: boolean) => {
    if (busy()) return;
    props.onOpenChange(open);
    if (!open) {
      setName("");
      setTried(false);
    }
  };
  const submit = async () => {
    setTried(true);
    if (!name().trim() || busy()) return;
    setBusy(true);
    try {
      await props.save(name().trim());
    } finally {
      setBusy(false);
    }
    close(false);
  };
  return (
    <Dialog
      title={t().sqlSaveAs}
      open={props.open}
      onOpenChange={close}
      foot={
        <>
          <Button onClick={() => close(false)} disabled={busy()}>
            {words().cancel}
          </Button>
          <Button variant="primary" icon="bookmark" busy={busy()} onClick={() => void submit()}>
            {words().save}
          </Button>
        </>
      }
    >
      <Field name="queryName" label={t().sqlQueryName} required error={tried() && !name().trim() ? words().required : undefined}>
        <Input
          value={name()}
          onInput={setName}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.isComposing) void submit();
          }}
        />
      </Field>
    </Dialog>
  );
}
