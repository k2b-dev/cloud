import { AutocompleteEditor, Button, Panes, type PanesLayout } from "@k2b/ui";
import { createMemo, createSignal, For, Show, type Accessor, type Setter } from "solid-js";
import type {
  PulseDashboard,
  PulseDashboardConfig,
  PulseDashboardDslCompileResult,
  PulseInventory,
  PulseMetricSummary,
  PulseSavedQuery,
  PulseSource,
} from "../../contracts";
import { pulseDashboardDslHighlight } from "../query-authoring";
import { usePulseMessages } from "../use-messages";
import { dashboardToDsl, openQueryReferenceWindow, quoteDashboardDslString, quoteQueryPart } from "./helpers";
import { DashboardContent, type DashboardRenderContext } from "./DashboardView";
import {
  createDashboardEditorPanesLayout,
  DASHBOARD_EDITOR_ITEM_IDS,
  DASHBOARD_EDITOR_PANES_KEY,
  initialPulsePanesLayout,
  persistPulsePanesLayout,
} from "./panes-state";

type ReferenceItem = {
  label: string;
  meta?: string;
  snippet?: string;
};

type DashboardEditorViewProps = {
  selectedBaseId: Accessor<string>;
  selectedDashboard: Accessor<PulseDashboard | null>;
  dashboardDslText: Accessor<string>;
  setDashboardDslText: Setter<string>;
  dashboardPreviewConfig: Accessor<PulseDashboardConfig | null>;
  dashboardDslDiagnostics: Accessor<PulseDashboardDslCompileResult | null>;
  dashboardDslSaving: Accessor<boolean>;
  initialPanesLayout?: PanesLayout | null;
  sources: Accessor<PulseSource[]>;
  inventory: Accessor<PulseInventory>;
  metrics: Accessor<PulseMetricSummary[]>;
  savedQueries: Accessor<PulseSavedQuery[]>;
  renderContext: DashboardRenderContext;
  onSave: () => void | Promise<void>;
  onOpenSettings: (dashboard: PulseDashboard) => void | Promise<void>;
};

const insertDashboardSnippet = (dsl: string, snippet: string): string => {
  const trimmed = dsl.trimEnd();
  const indentedSnippet = snippet
    .trim()
    .split("\n")
    .map((line) => (line.trim() ? `    ${line}` : line))
    .join("\n");
  const index = trimmed.lastIndexOf("}");
  if (index >= 0) return `${trimmed.slice(0, index).trimEnd()}\n\n  section "Added" {\n${indentedSnippet}\n  }\n${trimmed.slice(index)}`;
  return `${trimmed}\n\n  section "Added" {\n${indentedSnippet}\n  }\n}`;
};

const savedQueryDashboardSnippet = (query: PulseSavedQuery): string => {
  const text = query.query.trim().replace(/\s+/g, " ");
  const title = quoteDashboardDslString(query.name);
  const statement = text.startsWith("metric ") ? "line" : "table";
  return `${statement} ${title} {\n  query ${text}\n}`;
};

const ReferenceList = (props: {
  title: string;
  icon: string;
  items: ReferenceItem[];
  empty: string;
  onAppendSnippet: (snippet: string) => void;
  appendLabel: string;
}) => (
  <section class="paper p-3">
    <div class="mb-2 flex items-center gap-2 text-xs font-semibold text-primary">
      <i class={`${props.icon} text-sm text-dimmed`} />
      <span>{props.title}</span>
    </div>
    <Show when={props.items.length} fallback={<p class="text-xs text-dimmed">{props.empty}</p>}>
      <div class="max-h-40 overflow-auto">
        <For each={props.items.slice(0, 24)}>
          {(item) => (
            <Show
              when={item.snippet}
              fallback={
                <div class="flex w-full min-w-0 items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-xs">
                  <span class="truncate font-medium text-secondary">{item.label}</span>
                  <Show when={item.meta}>{(meta) => <span class="shrink-0 text-[11px] text-dimmed">{meta()}</span>}</Show>
                </div>
              }
            >
              {(snippet) => (
                <button
                  type="button"
                  class="flex w-full min-w-0 items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-zinc-100 dark:hover:bg-zinc-900"
                  onClick={() => props.onAppendSnippet(snippet())}
                  title={props.appendLabel}
                >
                  <span class="truncate font-medium text-secondary">{item.label}</span>
                  <Show when={item.meta}>{(meta) => <span class="shrink-0 text-[11px] text-dimmed">{meta()}</span>}</Show>
                </button>
              )}
            </Show>
          )}
        </For>
      </div>
    </Show>
  </section>
);

export default function DashboardEditorView(props: DashboardEditorViewProps) {
  const t = usePulseMessages();
  const [panesLayout, setPanesLayout] = createSignal(
    initialPulsePanesLayout(props.initialPanesLayout, createDashboardEditorPanesLayout(), DASHBOARD_EDITOR_ITEM_IDS),
  );
  const updatePanesLayout = (layout: PanesLayout) => {
    setPanesLayout(layout);
    persistPulsePanesLayout(DASHBOARD_EDITOR_PANES_KEY, layout);
  };

  const appendDashboardDslSnippet = (snippet: string) => {
    props.setDashboardDslText((current) => {
      const dashboard = props.selectedDashboard();
      const base = current.trim() || (dashboard ? dashboardToDsl(dashboard) : "");
      return base ? insertDashboardSnippet(base, snippet) : snippet;
    });
  };

  const dashboardReferenceSources = createMemo(() =>
    props.sources().map((source) => {
      const metrics = props.inventory().metrics.filter((metric) => metric.sourceId === source.id);
      const metric = metrics[0];
      return {
        label: source.name,
        meta: metrics.length ? `${source.kind} · ${t().metricCount({ count: metrics.length })}` : source.kind,
        snippet: metric
          ? `section ${quoteDashboardDslString(source.name)} {\n  line ${quoteDashboardDslString(metric.metric)} {\n    query metric ${quoteQueryPart(metric.metric)} ${metric.type === "counter" ? "rate" : "avg"} every 5m since 24h source ${source.id}\n  }\n}`
          : undefined,
      };
    }),
  );

  const dashboardReferenceResources = createMemo(() =>
    props.inventory().resources.map((resource) => {
      const metric = props.inventory().metrics.find((item) => item.resourceKey === resource.key);
      const sourceId = metric?.sourceId ?? resource.sourceIds[0] ?? null;
      const source = sourceId ? ` source ${sourceId}` : "";
      const dimensions = Object.entries(resource.dimensions ?? {});
      const scope = dimensions.length
        ? ` where ${dimensions.map(([key, value]) => `${key}=${quoteQueryPart(String(value))}`).join(", ")}`
        : ` entity ${quoteQueryPart(resource.id)}${resource.type ? ` entity_type ${quoteQueryPart(resource.type)}` : ""}`;
      return {
        label: resource.label,
        meta: `${resource.type ?? t().resource} · ${t().metricCount({ count: resource.metricCount })}`,
        snippet: metric
          ? `line ${quoteDashboardDslString(metric.metric)} {\n  query metric ${quoteQueryPart(metric.metric)} ${metric.type === "counter" ? "rate" : "avg"} every 5m since 24h${source}${scope}\n}`
          : undefined,
      };
    }),
  );

  const dashboardReferenceMetrics = createMemo(() =>
    props.metrics().map((metric) => ({
      label: metric.name,
      meta: metric.type,
      snippet: `line ${quoteDashboardDslString(metric.name)} {\n  query metric ${quoteQueryPart(metric.name)} ${metric.type === "counter" ? "rate" : "avg"} every 5m since 24h\n}`,
    })),
  );

  const dashboardReferenceEvents = createMemo(() => {
    const names = [...new Set(props.inventory().events.map((event) => event.kind))].sort();
    return names.map((name) => ({
      label: name,
      meta: "event",
      snippet: `table ${quoteDashboardDslString(name)} {\n  query events ${quoteQueryPart(name)} since 24h limit 100\n}`,
    }));
  });

  const dashboardReferenceStates = createMemo(() => {
    const names = [...new Set(props.inventory().states.map((state) => state.key))].sort();
    return names.map((name) => ({
      label: name,
      meta: "state",
      snippet: `table ${quoteDashboardDslString(name)} {\n  query states ${quoteQueryPart(name)} limit 100\n}`,
    }));
  });

  const dashboardReferenceLabels = createMemo(() => {
    const labels = new Map<string, Set<string>>();
    const addDimensions = (dimensions: Record<string, string>) => {
      for (const [key, value] of Object.entries(dimensions)) {
        if (!labels.has(key)) labels.set(key, new Set());
        labels.get(key)!.add(value);
      }
    };
    for (const item of props.inventory().metrics) addDimensions(item.dimensions);
    for (const item of props.inventory().events) addDimensions(item.dimensions);
    for (const item of props.inventory().states) addDimensions(item.dimensions);
    return [...labels.entries()]
      .map(([label, values]) => ({ label, meta: t().valueCount({ count: values.size }) }))
      .sort((left, right) => left.label.localeCompare(right.label));
  });

  const dashboardReferenceEntities = createMemo(() => {
    const entities = new Map<string, { type: string | null; count: number }>();
    const addEntity = (entityId: string | null, entityType: string | null) => {
      if (!entityId) return;
      const current = entities.get(entityId);
      entities.set(entityId, { type: current?.type ?? entityType, count: (current?.count ?? 0) + 1 });
    };
    for (const item of props.inventory().metrics) addEntity(item.resourceId, item.resourceType);
    for (const item of props.inventory().events) addEntity(item.entityId, item.entityType);
    for (const item of props.inventory().states) addEntity(item.entityId, item.entityType);
    return [...entities.entries()]
      .map(([label, value]) => ({ label, meta: value.type ? `${value.type} · ${value.count}` : `${value.count}` }))
      .sort((left, right) => left.label.localeCompare(right.label));
  });

  const dashboardReferenceSavedQueries = createMemo(() =>
    props.savedQueries().map((query) => ({
      label: query.name,
      meta: query.query.split(/\s+/)[0] ?? "query",
      snippet: savedQueryDashboardSnippet(query),
    })),
  );

  const renderReferenceList = (input: { title: string; icon: string; items: ReferenceItem[]; empty: string }) => (
    <ReferenceList {...input} appendLabel={t().appendDslSnippet} onAppendSnippet={appendDashboardDslSnippet} />
  );

  const renderEditorPane = () => (
    <div class="h-full overflow-hidden">
      <AutocompleteEditor
        value={props.dashboardDslText}
        onValueChange={(value) => props.setDashboardDslText(value)}
        highlight={pulseDashboardDslHighlight}
        variant="paper"
        fill
        lines={18}
        spellcheck={false}
        aria-label={t().dashboardDsl}
        aria-invalid={props.dashboardDslDiagnostics()?.ok === false}
        placeholder={
          'dashboard "Solar overview" {\n  section "Today" {\n    gauge "Charge" {\n      query metric solar.battery.charge_percent latest since 10m\n    }\n  }\n}'
        }
      />
    </div>
  );

  const renderInventoryPane = () => (
    <div class="grid h-full content-start gap-2 overflow-auto p-1 md:grid-cols-2 2xl:grid-cols-3">
      {renderReferenceList({
        title: t().sources,
        icon: "ti ti-database-share",
        items: dashboardReferenceSources(),
        empty: t().noSources,
      })}
      {renderReferenceList({
        title: t().resources,
        icon: "ti ti-cube",
        items: dashboardReferenceResources(),
        empty: t().noItemsYet({ items: t().resources.toLowerCase() }),
      })}
      {renderReferenceList({
        title: t().metrics,
        icon: "ti ti-chart-dots",
        items: dashboardReferenceMetrics(),
        empty: t().noItemsYet({ items: t().metrics.toLowerCase() }),
      })}
      {renderReferenceList({ title: t().events, icon: "ti ti-bolt", items: dashboardReferenceEvents(), empty: t().noItemsYet({ items: t().events.toLowerCase() }) })}
      {renderReferenceList({
        title: t().states,
        icon: "ti ti-toggle-right",
        items: dashboardReferenceStates(),
        empty: t().noItemsYet({ items: t().states.toLowerCase() }),
      })}
      {renderReferenceList({ title: t().labels, icon: "ti ti-tags", items: dashboardReferenceLabels(), empty: t().noItemsYet({ items: t().labels.toLowerCase() }) })}
      {renderReferenceList({
        title: t().entities,
        icon: "ti ti-cube",
        items: dashboardReferenceEntities(),
        empty: t().noItemsYet({ items: t().entities.toLowerCase() }),
      })}
      {renderReferenceList({
        title: t().savedQueries,
        icon: "ti ti-device-floppy",
        items: dashboardReferenceSavedQueries(),
        empty: t().noItemsYet({ items: t().savedQueries.toLowerCase() }),
      })}
    </div>
  );

  const renderDiagnosticsPane = () => (
    <div class="h-full overflow-auto p-3">
      <Show
        when={props.dashboardDslDiagnostics()}
        fallback={
          <p class="flex items-center gap-1.5 text-xs text-dimmed">
            <i class="ti ti-clock" /> {t().waitingForDslPreview}
          </p>
        }
      >
        {(result) => (
          <Show
            when={result().diagnostics.length}
            fallback={
              <p class="flex items-center gap-1.5 text-xs text-emerald-700 dark:text-emerald-300">
                <i class="ti ti-check" /> {t().dashboardDslValid}
              </p>
            }
          >
            <div class="space-y-2">
              <For each={result().diagnostics}>
                {(diagnostic) => (
                  <p class="flex items-start gap-1.5 text-xs text-red-600 dark:text-red-300">
                    <i class="ti ti-alert-circle mt-0.5" />
                    <span>
                      {diagnostic.line}:{diagnostic.column} · {diagnostic.message}
                    </span>
                  </p>
                )}
              </For>
            </div>
          </Show>
        )}
      </Show>
    </div>
  );

  return (
    <section class="flex min-h-[42rem] flex-1 flex-col gap-3 overflow-hidden pb-2">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div class="min-w-0">
          <h1 class="truncate text-base font-semibold text-primary">{props.selectedDashboard()?.name ?? t().dashboard} DSL</h1>
          <p class="mt-0.5 text-xs text-dimmed">{t().dashboardEditorDescription}</p>
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <span
            class={`chip border-0 ${
              props.dashboardDslDiagnostics()?.ok
                ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900 dark:text-emerald-200"
                : props.dashboardDslDiagnostics()
                  ? "bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-200"
                  : ""
            }`}
          >
            <i
              class={`ti ${
                props.dashboardDslDiagnostics()?.ok ? "ti-check" : props.dashboardDslDiagnostics() ? "ti-alert-circle" : "ti-clock"
              }`}
            />
            <span>{props.dashboardDslDiagnostics()?.ok ? t().valid : props.dashboardDslDiagnostics() ? t().invalid : t().waiting}</span>
          </span>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={!props.selectedDashboard() || props.dashboardDslSaving() || !props.dashboardDslDiagnostics()?.ok}
            onClick={() => void props.onSave()}
          >
            <i class={`ti ${props.dashboardDslSaving() ? "ti-loader-2 animate-spin" : "ti-device-floppy"}`} /> {t().save}
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={!props.selectedDashboard()}
            onClick={() => {
              const dashboard = props.selectedDashboard();
              if (dashboard) void props.onOpenSettings(dashboard);
            }}
          >
            <i class="ti ti-settings" /> {t().settings}
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => openQueryReferenceWindow(props.selectedBaseId(), { dashboardDsl: true })}
          >
            <i class="ti ti-external-link" /> {t().pulseQueryReference}
          </Button>
        </div>
      </div>

      <div class="min-h-0 flex-1 overflow-hidden">
        <Panes
          layout={panesLayout()}
          onLayoutChange={updatePanesLayout}
          class="h-full"
          ariaLabel={t().dashboardEditorPanes}
          items={[
            {
              id: "preview",
              title: t().preview,
              icon: "ti ti-eye",
              render: () => (
                <div class="h-full overflow-auto bg-zinc-50 p-3 dark:bg-zinc-950">
                  <DashboardContent config={props.dashboardPreviewConfig} context={props.renderContext} />
                </div>
              ),
            },
            { id: "editor", title: "DSL", icon: "ti ti-code", render: renderEditorPane },
            { id: "inventory", title: t().inventory, icon: "ti ti-database-search", render: renderInventoryPane },
            { id: "diagnostics", title: t().diagnostics, icon: "ti ti-alert-circle", render: renderDiagnosticsPane },
          ]}
        />
      </div>
    </section>
  );
}
