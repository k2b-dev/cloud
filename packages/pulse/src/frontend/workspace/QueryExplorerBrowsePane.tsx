import { ScrollArea, TextInput } from "@k2b/ui";
import { type Accessor, For, Show } from "solid-js";
import type { PulseCurrentState, PulseMetricSummary, PulseRecordedEvent, PulseSource } from "../../contracts";
import { usePulseMessages } from "../use-messages";
import { formatSignalValue, sourceKindIcon, sourceStatus, suggestionTagClass } from "./helpers";
import type { BrowseEntity } from "./types";

type BrowseSourceRow = {
  source: PulseSource;
  metricCount: number;
  eventCount: number;
  stateCount: number;
};

type BrowseMetricRow = {
  metric: PulseMetricSummary;
  seriesCount: number;
  sampleDimensions: Record<string, string>;
};

type BrowseEventRow = {
  kind: string;
  count: number;
  sample: PulseRecordedEvent;
};

type BrowseStateRow = {
  key: string;
  count: number;
  sample: PulseCurrentState;
};

type BrowseLabelGroup = {
  key: string;
  count: number;
  values: Array<{ key: string; value: string; count: number }>;
};

export default function QueryExplorerBrowsePane(props: {
  search: Accessor<string>;
  onSearchInput: (value: string) => void;
  selectedSource: Accessor<PulseSource | null>;
  selectedEntity: Accessor<BrowseEntity | null>;
  sourceId: Accessor<string>;
  sources: Accessor<BrowseSourceRow[]>;
  entities: Accessor<BrowseEntity[]>;
  metrics: Accessor<BrowseMetricRow[]>;
  events: Accessor<BrowseEventRow[]>;
  states: Accessor<BrowseStateRow[]>;
  labels: Accessor<BrowseLabelGroup[]>;
  onClearSourceScope: () => void;
  onClearEntityScope: () => void;
  onSelectSource: (sourceId: string) => void;
  onSelectEntity: (entityId: string) => void;
  onMetricQuery: (metric: PulseMetricSummary, sampleDimensions: Record<string, string>) => void;
  onEventQuery: (kind: string, sample: PulseRecordedEvent) => void;
  onStateQuery: (key: string, sample: PulseCurrentState) => void;
  onApplySourceFilter: (sourceId: string) => void;
  onApplyDimensionFilter: (key: string, value: string) => void;
}) {
  const t = usePulseMessages();
  const scopeTagClass = "chip border-0 bg-zinc-100 app-accent-text dark:bg-zinc-900";
  const clearScopeButtonClass = "ml-1 inline-flex text-dimmed transition hover:app-accent-text";
  const rowClass = "group block w-full rounded px-2 py-2 text-left transition hover:bg-zinc-100 dark:hover:bg-zinc-900";
  const actionClass =
    "inline-flex h-7 items-center gap-1 rounded-full bg-zinc-100 px-2.5 text-[11px] font-medium text-secondary transition hover:app-accent-text dark:bg-zinc-900";

  return (
    <div class="flex h-full min-h-0 flex-col overflow-hidden">
      <div class="shrink-0 space-y-2 p-3">
        <TextInput
          type="search"
          icon="ti ti-search"
          value={props.search}
          onValueChange={props.onSearchInput}
          placeholder={t().findSignalsPlaceholder}
          clearable
        />
        <div class="flex flex-wrap gap-2">
          <Show when={props.selectedSource()}>
            {(source) => (
              <span class={scopeTagClass}>
                <i class="ti ti-database-share" />
                <span class="truncate">{t().sourceScope({ name: source().name })}</span>
                <button type="button" class={clearScopeButtonClass} onClick={props.onClearSourceScope} aria-label={t().clearSourceScope}>
                  <i class="ti ti-x" />
                </button>
              </span>
            )}
          </Show>
          <Show when={props.selectedEntity()}>
            {(entity) => (
              <span class={scopeTagClass}>
                <i class="ti ti-cube" />
                <span class="truncate">{t().resourceScope({ id: entity().id })}</span>
                <button type="button" class={clearScopeButtonClass} onClick={props.onClearEntityScope} aria-label={t().clearResourceScope}>
                  <i class="ti ti-x" />
                </button>
              </span>
            )}
          </Show>
          <Show when={!props.selectedSource() && !props.selectedEntity()}>
            <span class="text-xs text-dimmed">{t().selectScopeHint}</span>
          </Show>
        </div>
      </div>

      <ScrollArea class="min-h-0 flex-1 px-3 pb-3">
        <div class="grid gap-3 xl:grid-cols-2">
          <section class="rounded bg-zinc-50/80 p-2 dark:bg-zinc-900/45">
            <div class="mb-1 flex items-center justify-between gap-2 px-1">
              <h3 class="text-label text-xs">{t().sources}</h3>
              <span class="text-[11px] text-dimmed">{t().shown({ count: props.sources().length })}</span>
            </div>
            <Show when={props.sources().length > 0} fallback={<p class="px-1 py-2 text-xs text-dimmed">{t().noMatchingSources}</p>}>
              <For each={props.sources()}>
                {({ source, metricCount, eventCount, stateCount }) => (
                  <div class="rounded transition hover:bg-white dark:hover:bg-zinc-950">
                    <button type="button" class={rowClass} onClick={() => props.onSelectSource(source.id)}>
                      <span class="flex items-center gap-2">
                        <i class={`${sourceKindIcon(source.kind)} text-dimmed`} />
                        <span class="min-w-0 flex-1 truncate text-sm font-medium text-secondary">{source.name}</span>
                        <span class={sourceStatus(source, { paused: t().paused, error: t().error, healthy: t().healthy, waiting: t().waiting }).text}>
                          {sourceStatus(source, { paused: t().paused, error: t().error, healthy: t().healthy, waiting: t().waiting }).label}
                        </span>
                      </span>
                      <span class="mt-1 block truncate text-[11px] text-dimmed">
                        {source.kind} · {t().ingestCounts({ metrics: metricCount, events: eventCount, states: stateCount })}
                      </span>
                    </button>
                  </div>
                )}
              </For>
            </Show>
          </section>

          <section class="rounded bg-zinc-50/80 p-2 dark:bg-zinc-900/45">
            <div class="mb-1 flex items-center justify-between gap-2 px-1">
              <h3 class="text-label text-xs">{t().resources}</h3>
              <span class="text-[11px] text-dimmed">{t().shown({ count: props.entities().length })}</span>
            </div>
            <Show when={props.entities().length > 0} fallback={<p class="px-1 py-2 text-xs text-dimmed">{t().noMatchingResources}</p>}>
              <For each={props.entities()}>
                {(entity) => (
                  <button type="button" class={rowClass} onClick={() => props.onSelectEntity(entity.id)}>
                    <span class="flex items-center gap-2">
                      <i class="ti ti-cube text-dimmed" />
                      <span class="min-w-0 flex-1 truncate text-sm font-medium text-secondary">{entity.id}</span>
                      <span class="text-[11px] text-dimmed">{entity.type ?? "entity"}</span>
                    </span>
                    <span class="mt-1 block truncate text-[11px] text-dimmed">
                      {t().ingestCounts({ metrics: entity.metricCount, events: entity.eventCount, states: entity.stateCount })}
                    </span>
                  </button>
                )}
              </For>
            </Show>
          </section>
        </div>

        <section class="mt-3 rounded bg-zinc-50/80 p-2 dark:bg-zinc-900/45">
          <div class="mb-1 flex items-center justify-between gap-2 px-1">
            <h3 class="text-label text-xs">{t().signals}</h3>
            <span class="text-[11px] text-dimmed">
              {t().ingestCounts({ metrics: props.metrics().length, events: props.events().length, states: props.states().length })}
            </span>
          </div>
          <div class="grid gap-2 xl:grid-cols-3">
            <div>
              <h4 class="px-1 pb-1 text-xs font-semibold text-dimmed">{t().metrics}</h4>
              <Show when={props.metrics().length > 0} fallback={<p class="px-1 py-2 text-xs text-dimmed">{t().noMatchingMetrics}</p>}>
                <For each={props.metrics()}>
                  {({ metric, seriesCount, sampleDimensions }) => (
                    <div class="rounded px-2 py-2 transition hover:bg-white dark:hover:bg-zinc-950">
                      <button type="button" class="block w-full text-left" onClick={() => props.onMetricQuery(metric, sampleDimensions)}>
                        <span class="block truncate text-sm font-medium text-secondary">{metric.name}</span>
                        <span class="block truncate text-[11px] text-dimmed">
                          {metric.type}
                          {metric.unit ? ` · ${metric.unit}` : ""} · {t().variantCount({ count: seriesCount })}
                        </span>
                      </button>
                      <div class="mt-2 flex flex-wrap gap-1">
                        <button type="button" class={actionClass} onClick={() => props.onMetricQuery(metric, sampleDimensions)}>
                          <i class="ti ti-code" /> {t().queryLower}
                        </button>
                        <Show when={props.sourceId()}>
                          <button type="button" class={actionClass} onClick={() => props.onApplySourceFilter(props.sourceId())}>
                            <i class="ti ti-database-share" /> {t().addSourceFilter}
                          </button>
                        </Show>
                      </div>
                    </div>
                  )}
                </For>
              </Show>
            </div>

            <div>
              <h4 class="px-1 pb-1 text-xs font-semibold text-dimmed">{t().events}</h4>
              <Show when={props.events().length > 0} fallback={<p class="px-1 py-2 text-xs text-dimmed">{t().noMatchingEvents}</p>}>
                <For each={props.events()}>
                  {(event) => (
                    <div class="rounded px-2 py-2 transition hover:bg-white dark:hover:bg-zinc-950">
                      <button type="button" class="block w-full text-left" onClick={() => props.onEventQuery(event.kind, event.sample)}>
                        <span class="block truncate text-sm font-medium text-secondary">{event.kind}</span>
                        <span class="block truncate text-[11px] text-dimmed">{t().recentRowCount({ count: event.count })}</span>
                      </button>
                    </div>
                  )}
                </For>
              </Show>
            </div>

            <div>
              <h4 class="px-1 pb-1 text-xs font-semibold text-dimmed">{t().states}</h4>
              <Show when={props.states().length > 0} fallback={<p class="px-1 py-2 text-xs text-dimmed">{t().noMatchingStates}</p>}>
                <For each={props.states()}>
                  {(state) => (
                    <div class="rounded px-2 py-2 transition hover:bg-white dark:hover:bg-zinc-950">
                      <button type="button" class="block w-full text-left" onClick={() => props.onStateQuery(state.key, state.sample)}>
                        <span class="block truncate text-sm font-medium text-secondary">{state.key}</span>
                        <span class="block truncate text-[11px] text-dimmed">
                          {t().currentRowCount({ count: state.count })} · {t().latestSignalValue({ value: formatSignalValue(state.sample.value) })}
                        </span>
                      </button>
                    </div>
                  )}
                </For>
              </Show>
            </div>
          </div>
        </section>

        <section class="mt-3 rounded bg-zinc-50/80 p-2 dark:bg-zinc-900/45">
          <div class="mb-2 flex items-center justify-between gap-2 px-1">
            <h3 class="text-label text-xs">{t().labels}</h3>
            <span class="text-[11px] text-dimmed">{t().addWhereFilterHint}</span>
          </div>
          <Show when={props.labels().length > 0} fallback={<p class="px-1 py-2 text-xs text-dimmed">{t().noMatchingLabels}</p>}>
            <div class="space-y-2">
              <For each={props.labels()}>
                {(group) => (
                  <div class="grid grid-cols-[5rem_minmax(0,1fr)] items-start gap-2">
                    <div class="truncate px-1 pt-1 text-xs font-medium text-dimmed">{group.key}</div>
                    <div class="flex flex-wrap gap-1">
                      <For each={group.values}>
                        {(filter) => (
                          <button
                            type="button"
                            class={suggestionTagClass}
                            onClick={() => props.onApplyDimensionFilter(filter.key, filter.value)}
                          >
                            <i class="ti ti-tag" />
                            <span class="truncate">{filter.value}</span>
                            <span class="text-dimmed">· {filter.count}</span>
                          </button>
                        )}
                      </For>
                    </div>
                  </div>
                )}
              </For>
            </div>
          </Show>
        </section>
      </ScrollArea>
    </div>
  );
}
