import { AutocompleteEditor, Button, TextInput, type Completion } from "@k2b/ui";
import { For, Show, type Accessor } from "solid-js";
import type { MetricQuery, PulseQueryCompileResult, PulseSource } from "../../contracts";
import { pulseQueryHighlight } from "../query-authoring";
import { suggestionTagClass } from "./helpers";
import { usePulseMessages } from "../use-messages";

type QuerySourceSuggestion = {
  source: PulseSource;
  count: number;
};

type QueryLabelSuggestion = {
  key: string;
  count: number;
  values: Array<{
    key: string;
    value: string;
    count: number;
  }>;
  hiddenValues: number;
};

type QuerySuggestionMatches = {
  sources: QuerySourceSuggestion[];
  labels: Array<{
    key: string;
    count: number;
    values: Array<{
      key: string;
      value: string;
      count: number;
    }>;
  }>;
};

type QueryExplorerEditorPaneProps = {
  queryText: Accessor<string>;
  onQueryInput: (value: string) => void;
  completions: Accessor<Completion[]>;
  diagnostics: Accessor<PulseQueryCompileResult | null>;
  running: Accessor<boolean>;
  compiledMetricQuery: Accessor<MetricQuery | null>;
  matchingSeriesCount: Accessor<number>;
  matchingSourcesCount: Accessor<number>;
  filterSuggestionCount: Accessor<number>;
  suggestionsExpanded: Accessor<boolean>;
  setSuggestionsExpanded: (value: boolean | ((current: boolean) => boolean)) => void;
  suggestionSearch: Accessor<string>;
  setSuggestionSearch: (value: string) => void;
  visibleSourceSuggestions: Accessor<QuerySourceSuggestion[]>;
  visibleLabelSuggestions: Accessor<QueryLabelSuggestion[]>;
  suggestionMatches: Accessor<QuerySuggestionMatches>;
  suggestionOverflow: Accessor<number>;
  canRun: Accessor<boolean>;
  canOpenReference: Accessor<boolean>;
  onRun: () => void;
  onOpenReference: () => void;
  onApplySourceFilter: (sourceId: string) => void;
  onApplyDimensionFilter: (key: string, value: string) => void;
};

const QueryEditorInput = (
  props: Pick<QueryExplorerEditorPaneProps, "queryText" | "onQueryInput" | "onRun" | "completions" | "diagnostics">,
) => {
  const t = usePulseMessages();
  return (
  <AutocompleteEditor
    value={props.queryText}
    onValueChange={props.onQueryInput}
    onSubmit={props.onRun}
    completions={props.completions()}
    highlight={pulseQueryHighlight}
    restoreExpansionOnBackspace={false}
    variant="paper"
    lines={7}
    spellcheck={false}
    placeholder="metric orders.created increase every 1h since 7d where channel=web"
    aria-label={t().pulseQuery}
    aria-invalid={props.diagnostics()?.ok === false}
  />
  );
};

const QueryDiagnostics = (props: Pick<QueryExplorerEditorPaneProps, "diagnostics" | "running">) => {
  const t = usePulseMessages();
  return (
  <div class="mt-2 flex flex-wrap items-center gap-2 text-xs">
    <For each={props.diagnostics()?.diagnostics ?? []}>
      {(diagnostic) => (
        <span class={diagnostic.severity === "error" ? "text-red-600 dark:text-red-300" : "text-dimmed"}>
          <i class={diagnostic.severity === "error" ? "ti ti-alert-circle" : "ti ti-check"} /> {diagnostic.message}
        </span>
      )}
    </For>
    <Show when={props.running()}>
      <span class="text-dimmed">
        <i class="ti ti-loader-2 animate-spin" /> {t().updatingPreview}
      </span>
    </Show>
  </div>
  );
};

const SuggestionStat = (props: { icon: string; label: string }) => (
  <span class="inline-flex items-center gap-1">
    <i class={`ti ${props.icon}`} />
    {props.label}
  </span>
);

const SuggestionToggle = (
  props: Pick<QueryExplorerEditorPaneProps, "suggestionOverflow" | "suggestionsExpanded" | "setSuggestionsExpanded">,
) => {
  const t = usePulseMessages();
  return (
  <Show when={props.suggestionOverflow() > 0 || props.suggestionsExpanded()}>
    <Button
      type="button"
      variant="subtle"
      size="xs"
      class="rounded-full"
      onClick={() => props.setSuggestionsExpanded((expanded) => !expanded)}
    >
      <i class={`ti ${props.suggestionsExpanded() ? "ti-chevron-up" : "ti-adjustments-horizontal"}`} />
      {props.suggestionsExpanded() ? t().showLess : t().browseMore({ count: props.suggestionOverflow() })}
    </Button>
  </Show>
  );
};

const SuggestedRefinementsHeader = (
  props: Pick<
    QueryExplorerEditorPaneProps,
    | "matchingSeriesCount"
    | "matchingSourcesCount"
    | "filterSuggestionCount"
    | "suggestionOverflow"
    | "suggestionsExpanded"
    | "setSuggestionsExpanded"
  >,
) => {
  const t = usePulseMessages();
  return (
  <div class="flex flex-wrap items-start justify-between gap-3">
    <div class="min-w-0">
      <div class="flex flex-wrap items-center gap-2">
        <h3 class="text-sm font-semibold text-primary">{t().suggestedRefinements}</h3>
        <span class="rounded-full bg-zinc-100 px-2 py-0.5 text-[11px] font-medium text-dimmed dark:bg-zinc-900">{t().autocompleteHint}</span>
      </div>
      <p class="mt-1 text-xs text-dimmed">{t().suggestedRefinementsDescription}</p>
    </div>
    <div class="flex flex-wrap items-center justify-end gap-x-3 gap-y-1 text-xs text-dimmed">
      <SuggestionStat icon="ti-stack-2" label={t().variantCount({ count: props.matchingSeriesCount() })} />
      <SuggestionStat icon="ti-database-share" label={t().sourceCount({ count: props.matchingSourcesCount() })} />
      <SuggestionStat icon="ti-tags" label={t().labelKeyCount({ count: props.filterSuggestionCount() })} />
      <SuggestionToggle
        suggestionOverflow={props.suggestionOverflow}
        suggestionsExpanded={props.suggestionsExpanded}
        setSuggestionsExpanded={props.setSuggestionsExpanded}
      />
    </div>
  </div>
  );
};

const SuggestionSearch = (
  props: Pick<QueryExplorerEditorPaneProps, "suggestionsExpanded" | "suggestionSearch" | "setSuggestionSearch">,
) => {
  const t = usePulseMessages();
  return (
  <Show when={props.suggestionsExpanded()}>
    <div class="mt-3 max-w-xl">
      <TextInput
        type="search"
        icon="ti ti-search"
        value={props.suggestionSearch}
        onValueChange={props.setSuggestionSearch}
        placeholder={t().suggestedSearchPlaceholder}
        clearable
      />
    </div>
  </Show>
  );
};

const SourceSuggestionRow = (
  props: Pick<QueryExplorerEditorPaneProps, "compiledMetricQuery" | "visibleSourceSuggestions" | "onApplySourceFilter">,
) => {
  const t = usePulseMessages();
  return (
  <Show when={!props.compiledMetricQuery()?.sourceId && props.visibleSourceSuggestions().length > 0}>
    <div class="grid grid-cols-[4.75rem_minmax(0,1fr)] items-start gap-2">
      <div class="pt-1 text-xs font-medium text-dimmed">{t().sources}</div>
      <div class="flex flex-wrap gap-2">
        <For each={props.visibleSourceSuggestions()}>
          {({ source, count }) => (
            <button type="button" class={suggestionTagClass} onClick={() => props.onApplySourceFilter(source.id)}>
              <i class="ti ti-database-share" />
              <span class="truncate">{source.name}</span>
              <span class="text-dimmed">· {count}</span>
            </button>
          )}
        </For>
      </div>
    </div>
  </Show>
  );
};

const LabelSuggestionRow = (props: {
  group: QueryLabelSuggestion;
  onApplyDimensionFilter: QueryExplorerEditorPaneProps["onApplyDimensionFilter"];
}) => {
  const t = usePulseMessages();
  return (
  <div class="grid grid-cols-[4.75rem_minmax(0,1fr)] items-start gap-2">
    <div class="truncate pt-1 text-xs font-medium text-dimmed" title={`${props.group.key} · ${t().variantCount({ count: props.group.count })}`}>
      {props.group.key}
    </div>
    <div class="flex flex-wrap gap-2">
      <For each={props.group.values}>
        {(filter) => (
          <button
            type="button"
            class={suggestionTagClass}
            onClick={() => props.onApplyDimensionFilter(filter.key, filter.value)}
            title={t().addWhereFilter({ key: filter.key, value: filter.value })}
          >
            <i class="ti ti-tag" />
            <span class="truncate">{filter.value}</span>
            <span class="text-dimmed">· {filter.count}</span>
          </button>
        )}
      </For>
      <Show when={props.group.hiddenValues > 0}>
        <span class="inline-flex h-7 items-center px-2 text-xs text-dimmed">{t().moreCount({ count: props.group.hiddenValues })}</span>
      </Show>
    </div>
  </div>
  );
};

const SuggestedRefinementRows = (
  props: Pick<
    QueryExplorerEditorPaneProps,
    | "compiledMetricQuery"
    | "visibleSourceSuggestions"
    | "onApplySourceFilter"
    | "visibleLabelSuggestions"
    | "onApplyDimensionFilter"
    | "suggestionsExpanded"
    | "suggestionMatches"
  >,
) => {
  const t = usePulseMessages();
  return (
  <div class="mt-3 space-y-2">
    <SourceSuggestionRow
      compiledMetricQuery={props.compiledMetricQuery}
      visibleSourceSuggestions={props.visibleSourceSuggestions}
      onApplySourceFilter={props.onApplySourceFilter}
    />
    <For each={props.visibleLabelSuggestions()}>
      {(group) => <LabelSuggestionRow group={group} onApplyDimensionFilter={props.onApplyDimensionFilter} />}
    </For>
    <Show
      when={props.suggestionsExpanded() && props.suggestionMatches().sources.length === 0 && props.suggestionMatches().labels.length === 0}
    >
      <p class="text-xs text-dimmed">{t().noSuggestedFilters}</p>
    </Show>
  </div>
  );
};

const SuggestedRefinements = (props: QueryExplorerEditorPaneProps) => (
  <Show when={props.compiledMetricQuery() && props.matchingSeriesCount() > 0}>
    <section class="mt-3 rounded bg-zinc-50 p-3 dark:bg-zinc-900/50">
      <SuggestedRefinementsHeader {...props} />
      <SuggestionSearch {...props} />
      <SuggestedRefinementRows {...props} />
    </section>
  </Show>
);

const EmptyMetricMatch = (props: Pick<QueryExplorerEditorPaneProps, "compiledMetricQuery" | "matchingSeriesCount">) => {
  const t = usePulseMessages();
  return (
  <Show when={props.compiledMetricQuery() && props.matchingSeriesCount() === 0}>
    <div class="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-dimmed">
      <span class="inline-flex items-center gap-1">
        <i class="ti ti-stack-2" /> {t().noVariantsMatched}
      </span>
    </div>
  </Show>
  );
};

const QueryExplorerActions = (
  props: Pick<QueryExplorerEditorPaneProps, "canRun" | "running" | "onRun" | "canOpenReference" | "onOpenReference">,
) => {
  const t = usePulseMessages();
  return (
  <div class="flex shrink-0 flex-wrap items-center gap-2 px-3 py-2">
    <Button type="button" variant="secondary" size="sm" disabled={!props.canRun() || props.running()} onClick={props.onRun}>
      <i class={`ti ${props.running() ? "ti-loader-2 animate-spin" : "ti-refresh"}`} /> {t().reload}
    </Button>
    <Button type="button" variant="secondary" size="sm" disabled={!props.canOpenReference()} onClick={props.onOpenReference}>
      <i class="ti ti-external-link" /> {t().openReference}
    </Button>
  </div>
  );
};

export default function QueryExplorerEditorPane(props: QueryExplorerEditorPaneProps) {
  return (
    <div class="flex h-full min-h-0 flex-col overflow-hidden">
      <div class="min-h-0 flex-1 overflow-auto p-3">
        <QueryEditorInput {...props} />
        <QueryDiagnostics diagnostics={props.diagnostics} running={props.running} />
        <SuggestedRefinements {...props} />
        <EmptyMetricMatch compiledMetricQuery={props.compiledMetricQuery} matchingSeriesCount={props.matchingSeriesCount} />
      </div>
      <QueryExplorerActions {...props} />
    </div>
  );
}
