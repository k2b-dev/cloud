import { query } from "@k2b/stdlib/solid";
import { Button, Dropdown, FilterChip, Placeholder, Skeleton, TextInput, useLocale } from "@k2b/ui";
import { createEffect, createMemo, createSignal, For, type JSX, Match, on, Show, Switch } from "solid-js";
import type { ActivityBatchContext, ActivityChain, ActivityEntry, ActivityPage, HistoryAction } from "../activity-contracts";
import HistoryUnavailable, { isHistoryUnavailable } from "./HistoryUnavailable";
import { dayGroups, type HistoryActions, type HistoryEnvironment, historyRows } from "./history-actions";
import { useHistoryMessages } from "./history-messages";
import { type ActivityFilters, type ActivityRequest, type ActivityWhen, activityRequest } from "./history-requests";
import { HistoryRow, MoreFooter, SkeletonRows } from "./history-rows";
import MissingItemView from "./MissingItemView";

/* ------------------------------------------------------------------ activity view */

const WHAT: readonly HistoryAction[] = [
  "folder.create",
  "file.upload",
  "file.overwrite",
  "file.edit",
  "item.rename",
  "item.move",
  "item.copy",
  "item.trash",
  "item.restore",
  "item.purge",
  "version.restore",
  "share.create",
  "share.revoke",
  "item.differs",
  "item.missing",
];
const filterKey = (filters: ActivityFilters) =>
  JSON.stringify([
    filters.baseId ?? null,
    filters.path ?? null,
    filters.scope ?? "item",
    filters.actor ?? null,
    filters.action ?? null,
    filters.when ?? null,
    filters.q ?? null,
  ]);

export type ActivityViewProps = {
  env: HistoryEnvironment;
  actions?: HistoryActions;
  filters: ActivityFilters;
  onFiltersChange: (filters: ActivityFilters) => void;
  /** Bases and people this person may filter by; labels are final display names. */
  bases: readonly { id: string; label: string }[];
  people: readonly { id: string; label: string }[];
  /** Authorized SSR snapshot for `filters`. */
  initial?: { filters: ActivityFilters; page: ActivityPage } | null;
  load: (request: ActivityRequest, signal: AbortSignal) => Promise<ActivityPage>;
  loadChain: (entry: ActivityEntry, signal: AbortSignal) => Promise<ActivityChain>;
  loadBatch?: (entry: ActivityEntry, signal: AbortSignal) => Promise<ActivityBatchContext>;
  /** Configured retention, named when a history search finds nothing. */
  retentionDays: number;
  /** Optional trailing head controls, such as the administration's export. */
  headActions?: JSX.Element;
};

export default function ActivityView(props: ActivityViewProps) {
  const h = useHistoryMessages();
  const locale = useLocale();
  const source = () => filterKey(props.filters);
  const pages = query.createInfinite({
    source,
    initial:
      props.initial && filterKey(props.initial.filters) === source()
        ? { source: source(), pages: [{ source: source(), page: props.initial.page }] }
        : undefined,
    loadPage: async (key, { cursor, abortSignal }) => ({
      source: key,
      page: await props.load({ ...activityRequest(props.filters, props.env), ...(cursor ? { cursor } : {}) }, abortSignal),
    }),
    getNextCursor: (result: { source: string; page: ActivityPage }) => result.page.next,
  });
  // The query keeps its last good value while a new source loads; it is not a result for the new filters.
  const visiblePages = createMemo(() =>
    pages
      .pages()
      .filter((result) => result.source === source())
      .map((result) => result.page),
  );
  const entries = createMemo(() => visiblePages().flatMap((page) => page.items));
  const rows = createMemo(() => historyRows(entries(), { batches: true }));
  const groups = createMemo(() => dayGroups(rows(), locale(), h(), props.env));
  const limited = () => visiblePages().some((page) => page.searchLimitReached);
  const [text, setText] = createSignal(props.filters.q ?? "");
  // Back and forward change the URL; the field follows it.
  createEffect(
    on(
      () => props.filters.q,
      (q) => setText(q ?? ""),
      { defer: true },
    ),
  );
  const filtered = () =>
    !!(props.filters.baseId || props.filters.path || props.filters.actor || props.filters.action || props.filters.when);
  const change = (patch: Partial<ActivityFilters>) => {
    const next: ActivityFilters = { ...props.filters, ...patch };
    for (const key of Object.keys(next) as (keyof ActivityFilters)[])
      if (next[key] === undefined || (next[key] === "" && key !== "path")) delete next[key];
    props.onFiltersChange(next);
  };
  const resetFilters = () =>
    change({ baseId: undefined, path: undefined, scope: undefined, actor: undefined, action: undefined, when: undefined });
  const submit = () => change({ q: text().trim() || undefined });
  const single = (value: string[]) => value.at(-1);
  const placeLabel = () => props.bases.find((base) => base.id === props.filters.baseId)?.label;
  const emptyText = () => {
    const place = placeLabel();
    const range = props.filters.when
      ? h()[({ today: "rangeToday", "7": "range7", "30": "range30", "365": "range365" } as const)[props.filters.when]]
      : null;
    if (place && range) return h().emptyIn.replace("{place}", place).replace("{range}", range);
    if (range) return h().emptyRange.replace("{range}", range);
    if (place) return h().emptyPlace.replace("{place}", place);
    return h().emptyAny;
  };
  const loadedOnce = () => visiblePages().length > 0;
  const actionLabel = (action: HistoryAction) => {
    const labels: Partial<Record<HistoryAction, string>> = {
      "folder.create": h().whatCreated,
      "file.upload": h().whatUploaded,
      "file.overwrite": h().whatOverwritten,
      "file.edit": h().whatEdited,
      "item.rename": h().whatRenamed,
      "item.move": h().whatMoved,
      "item.copy": h().whatCopied,
      "item.trash": h().whatTrashed,
      "item.restore": h().whatRestored,
      "item.purge": h().whatPurged,
      "version.restore": h().whatVersionRestored,
      "share.create": h().whatShareCreated,
      "share.revoke": h().whatShareRevoked,
      "item.differs": h().whatDiffers,
      "item.missing": h().whatMissing,
    };
    return labels[action] ?? action;
  };

  return (
    <section class="filesv2-history" aria-label={h().activity}>
      <div class="filesv2-history-head">
        <TextInput
          type="search"
          icon="ti ti-search"
          class="filesv2-history-search"
          placeholder={h().searchPlaceholder}
          aria-label={h().searchLabel}
          maxLength={4096}
          value={text()}
          onValueChange={setText}
          onSubmit={submit}
          clearable
          clearLabel={h().clearSearch}
          onClear={() => {
            setText("");
            if (props.filters.q) change({ q: undefined });
          }}
        />
        <div class="filesv2-history-head__filters k2b-focus-inset">
          <FilterChip
            label={h().filterBase}
            icon="ti ti-folders"
            showValue
            value={props.filters.baseId ? [props.filters.baseId] : []}
            onValueChange={(value) => change({ baseId: single(value), path: undefined, scope: undefined })}
            options={[{ options: props.bases.map((base) => ({ value: base.id, label: base.label })) }]}
          />
          <Show when={props.filters.baseId && props.filters.path}>
            {(path) => (
              <FilterChip
                label={h().filterItem}
                icon="ti ti-file"
                showValue
                value={[path()]}
                onValueChange={(value) => change({ path: single(value), scope: single(value) ? props.filters.scope : undefined })}
                options={[{ options: [{ value: path(), label: path().split("/").at(-1) ?? path() }] }]}
              />
            )}
          </Show>
          <FilterChip
            label={h().filterWho}
            icon="ti ti-user"
            showValue
            value={props.filters.actor ? [props.filters.actor] : []}
            onValueChange={(value) => change({ actor: single(value) })}
            options={[{ options: props.people.map((person) => ({ value: person.id, label: person.label })) }]}
          />
          <FilterChip
            label={h().filterWhat}
            icon="ti ti-activity"
            showValue
            value={props.filters.action ? [props.filters.action] : []}
            onValueChange={(value) => change({ action: single(value) as HistoryAction | undefined })}
            options={[{ options: WHAT.map((action) => ({ value: action, label: actionLabel(action) })) }]}
          />
          <FilterChip
            label={h().filterWhen}
            icon="ti ti-calendar"
            showValue
            value={props.filters.when ? [props.filters.when] : []}
            onValueChange={(value) => change({ when: single(value) as ActivityWhen | undefined })}
            options={[
              {
                options: [
                  { value: "today", label: h().whenToday },
                  { value: "7", label: h().when7 },
                  { value: "30", label: h().when30 },
                  { value: "365", label: h().when365 },
                ],
              },
            ]}
          />
          <Show when={filtered()}>
            <Button size="sm" variant="text" class="filesv2-history-link" onClick={resetFilters}>
              {h().reset}
            </Button>
          </Show>
        </div>
        <div class="filesv2-history-head__actions">
          <Show
            when={props.headActions}
            fallback={
              <Dropdown.Root
                items={[
                  { label: h().refreshActivity, icon: "ti ti-refresh", disabled: pages.loading(), action: () => void pages.refresh() },
                  { label: h().resetFilters, icon: "ti ti-filter-off", disabled: !filtered(), action: resetFilters },
                ]}
                align="end"
              >
                <Dropdown.Trigger iconOnly label={h().activityActions}>
                  <i class="ti ti-dots" aria-hidden="true" />
                </Dropdown.Trigger>
              </Dropdown.Root>
            }
          >
            {props.headActions}
          </Show>
        </div>
      </div>
      <div class="filesv2-history-body" aria-busy={pages.loading() || pages.refreshing()}>
        <Show
          when={!props.filters.q || props.filters.baseId?.startsWith("freeipa:") || isHistoryUnavailable(pages.error())}
          fallback={
            <MissingItemView
              query={props.filters.q ?? ""}
              entries={entries()}
              state={
                pages.error() && !loadedOnce() ? "error" : (pages.loading() || pages.refreshing()) && !loadedOnce() ? "loading" : "ready"
              }
              onRetry={() => void pages.refresh()}
              hasMore={pages.hasMore()}
              loadingMore={pages.loadingMore()}
              moreFailed={!!pages.error() && loadedOnce()}
              onLoadMore={() => void (pages.hasMore() ? pages.loadMore() : pages.refresh())}
              limitReached={limited()}
              env={props.env}
              actions={props.actions}
              loadChain={props.loadChain}
              loadBatch={props.loadBatch}
              retentionDays={props.retentionDays}
              onClearSearch={() => {
                setText("");
                change({ q: undefined });
              }}
              onChanged={() => void pages.refresh()}
            />
          }
        >
          <div class="filesv2-history-list">
            <Switch>
              <Match when={props.filters.baseId?.startsWith("freeipa:") || isHistoryUnavailable(pages.error())}>
                <HistoryUnavailable />
              </Match>
              <Match when={!loadedOnce() && pages.error()}>
                <Placeholder
                  class="filesv2-history-placeholder"
                  state="error"
                  icon="ti ti-alert-triangle"
                  title={h().errorTitle}
                  description={h().errorText}
                  action={
                    <Button variant="secondary" onClick={() => void pages.refresh()}>
                      <i class="ti ti-refresh" aria-hidden="true" />
                      {h().retry}
                    </Button>
                  }
                />
              </Match>
              <Match when={!loadedOnce()}>
                <p class="sr-only" role="status">
                  {h().loading}
                </p>
                <Skeleton class="filesv2-history-skeleton__day" />
                <SkeletonRows count={4} variant="list" />
                <Skeleton class="filesv2-history-skeleton__day" />
                <SkeletonRows count={3} variant="list" />
              </Match>
              <Match when={rows().length === 0 && (pages.hasMore() || pages.error())}>
                <p class="filesv2-history-scanned">{h().nothingVisibleYet}</p>
                <MoreFooter
                  hasMore={pages.hasMore()}
                  loadingMore={pages.loadingMore()}
                  failed={!!pages.error()}
                  limitReached={limited()}
                  onMore={() => void (pages.hasMore() ? pages.loadMore() : pages.refresh())}
                />
              </Match>
              <Match when={rows().length === 0}>
                <Placeholder
                  class="filesv2-history-placeholder"
                  state={filtered() ? "no-results" : "empty"}
                  icon="ti ti-history"
                  title={filtered() ? h().emptyTitle : h().noActivityTitle}
                  description={filtered() ? emptyText() : h().noActivityText}
                  action={
                    filtered() ? (
                      <Button variant="secondary" onClick={resetFilters}>
                        <i class="ti ti-filter-off" aria-hidden="true" />
                        {h().resetFilters}
                      </Button>
                    ) : undefined
                  }
                />
              </Match>
              <Match when={rows().length > 0}>
                <For each={groups()}>
                  {(group) => (
                    <section class="filesv2-history-day" aria-label={group.detail ? `${group.label}, ${group.detail}` : group.label}>
                      <h2 class="filesv2-history-day__title">
                        {group.label}
                        <Show when={group.detail}>
                          <small>{group.detail}</small>
                        </Show>
                      </h2>
                      <ul class="filesv2-history-rows">
                        <For each={group.rows}>
                          {(row) => (
                            <li>
                              <HistoryRow
                                row={row}
                                env={props.env}
                                actions={props.actions}
                                context="activity"
                                dated
                                variant="list"
                                onChanged={() => void pages.refresh()}
                              />
                            </li>
                          )}
                        </For>
                      </ul>
                    </section>
                  )}
                </For>
                <MoreFooter
                  hasMore={pages.hasMore()}
                  loadingMore={pages.loadingMore()}
                  failed={!!pages.error()}
                  limitReached={limited()}
                  onMore={() => void (pages.hasMore() ? pages.loadMore() : pages.refresh())}
                />
              </Match>
            </Switch>
          </div>
        </Show>
      </div>
    </section>
  );
}
