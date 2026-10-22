import { query } from "@k2b/stdlib/solid";
import { Avatar, Button, DataTable, FilterChip, InlineGuidance, Placeholder, Skeleton, StatusBadge, TextInput, useLocale } from "@k2b/ui";
import { createEffect, createMemo, createSignal, For, Match, on, onCleanup, Show, Switch } from "solid-js";
import type { ActivityBasesPage, ActivityPage, HistoryAction } from "../activity-contracts";
import { type ActivityRequest, type ActivityWhen, activityRequest, HistoryRow, MoreFooter, SkeletonRows } from "./ActivityView";
import {
  ADMIN_SEARCH_LIMIT,
  type AdminActivityBase,
  type AdminActivityFilters,
  type AdminBasesLoader,
  adminBaseLabel,
  adminBaseOptions,
  adminChannel,
  adminItem,
  adminPlaceDescriber,
  adminTime,
  adminWhat,
  adminWho,
  entryBase,
  loadAdminBaseLabels,
} from "./admin-history";
import { useAdminHistoryMessages } from "./admin-history-messages";
import { openAdminBasePicker, openExportHistoryDialog } from "./ExportHistoryDialog";
import { actorOf, dayGroups, type HistoryEnvironment, type HistoryRowModel, historyRows, statusOf } from "./history-actions";
import { useHistoryMessages } from "./history-messages";

export type AdminHistoryProps = {
  env: HistoryEnvironment;
  filters: AdminActivityFilters;
  onFiltersChange: (filters: AdminActivityFilters) => void;
  /** Bounded first page, plus exact labels for the SSR history page. */
  bases: ActivityBasesPage | null;
  baseLabels?: readonly AdminActivityBase[];
  loadBases: AdminBasesLoader;
  /** Authorized SSR snapshot for `filters`. */
  initial?: { filters: AdminActivityFilters; page: ActivityPage } | null;
  load: (request: ActivityRequest, signal: AbortSignal) => Promise<ActivityPage>;
};

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
const filterKey = (filters: AdminActivityFilters) =>
  JSON.stringify([filters.baseId ?? null, filters.actor ?? null, filters.action ?? null, filters.when ?? null, filters.q ?? null]);

/**
 * The administration's history across all storage: the same filters and search as Activity, a table on wide screens
 * and Activity's list on narrow ones. Both show the same loaded pages; CSS picks one, so server and browser agree.
 */
export default function AdminHistory(props: AdminHistoryProps) {
  const h = useHistoryMessages();
  const a = useAdminHistoryMessages();
  const locale = useLocale();
  const [labels, setLabels] = createSignal<AdminActivityBase[]>([...(props.bases?.items ?? []), ...(props.baseLabels ?? [])]);
  createEffect(
    on(
      () => [props.bases, props.baseLabels] as const,
      ([page, extra]) => {
        setLabels([...(page?.items ?? []), ...(extra ?? [])]);
      },
      { defer: true },
    ),
  );
  const byBinding = createMemo(() => new Map(labels().map((base) => [base.bindingId, base])));
  const env = createMemo<HistoryEnvironment>(() => ({ ...props.env, describePlace: adminPlaceDescriber(byBinding(), a(), locale()) }));
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
  const groups = createMemo(() => dayGroups(rows(), locale(), h(), env()));
  const loadedOnce = () => visiblePages().length > 0;
  const limited = () => visiblePages().some((page) => page.searchLimitReached);

  // People to filter by are the actors seen so far; the reader has no directory of them.
  const [people, setPeople] = createSignal<Record<string, string>>({});
  createEffect(() => {
    const seen = entries().filter((entry) => entry.actor.userId && entry.actor.name && !people()[entry.actor.userId]);
    if (seen.length)
      setPeople((known) => ({ ...known, ...Object.fromEntries(seen.map((entry) => [entry.actor.userId!, entry.actor.name!])) }));
  });
  const peopleOptions = () => {
    const known = Object.entries(people()).map(([id, label]) => ({ value: id, label }));
    const chosen = props.filters.actor;
    return chosen && !people()[chosen] ? [...known, { value: chosen, label: h().selectedPerson }] : known;
  };
  const baseOptions = createMemo(() => adminBaseOptions(labels(), a(), locale()));
  const [labelsLoading, setLabelsLoading] = createSignal(false);
  const [labelsFailed, setLabelsFailed] = createSignal(false);
  const [retryLabels, setRetryLabels] = createSignal(0);
  let metadata: AbortController | undefined;
  createEffect(
    on(
      () => [JSON.stringify(entries().map((entry) => entry.id)), props.filters.baseId, retryLabels(), props.bases, props.baseLabels],
      () => {
        metadata?.abort();
        const controller = new AbortController();
        metadata = controller;
        setLabelsLoading(true);
        setLabelsFailed(false);
        void loadAdminBaseLabels(entries(), labels(), props.filters.baseId, props.loadBases, controller.signal)
          .then((loaded) => {
            if (!controller.signal.aborted)
              setLabels((known) => [...new Map([...known, ...loaded].map((base) => [base.bindingId, base])).values()]);
          })
          .catch(() => {
            if (!controller.signal.aborted) setLabelsFailed(true);
          })
          .finally(() => {
            if (!controller.signal.aborted) setLabelsLoading(false);
          });
      },
    ),
  );
  onCleanup(() => metadata?.abort());
  const chooseBase = async (value: string[]) => {
    if (value.at(-1) !== "search-bases") {
      change({ baseId: single(value) });
      return;
    }
    const picked = await openAdminBasePicker({
      bases: props.bases,
      selected: props.filters.baseId,
      labels: labels(),
      title: a().base,
      load: async (input, signal) => {
        const page = await props.loadBases(input, signal);
        signal.throwIfAborted();
        setLabels((known) => [...new Map([...known, ...page.items].map((base) => [base.bindingId, base])).values()]);
        return page;
      },
    });
    if (typeof picked === "string") change({ baseId: picked || undefined });
  };
  const placeLabel = () => baseOptions().find((base) => base.value === props.filters.baseId)?.label;

  const [text, setText] = createSignal(props.filters.q ?? "");
  // Back and forward change the address; the field follows it.
  createEffect(
    on(
      () => props.filters.q,
      (q) => setText(q ?? ""),
      { defer: true },
    ),
  );
  const filtered = () => !!(props.filters.baseId || props.filters.actor || props.filters.action || props.filters.when);
  const change = (patch: Partial<AdminActivityFilters>) => {
    const next: AdminActivityFilters = { ...props.filters, ...patch };
    for (const key of Object.keys(next) as (keyof AdminActivityFilters)[]) if (!next[key]) delete next[key];
    props.onFiltersChange(next);
  };
  const resetFilters = () => change({ baseId: undefined, actor: undefined, action: undefined, when: undefined });
  const single = (value: string[]) => value.at(-1);
  const emptyText = () => {
    const range = props.filters.when
      ? h()[({ today: "rangeToday", "7": "range7", "30": "range30", "365": "range365" } as const)[props.filters.when]]
      : null;
    const place = placeLabel();
    if (place && range) return h().emptyIn.replace("{place}", place).replace("{range}", range);
    if (place) return h().emptyPlace.replace("{place}", place);
    return range ? a().emptyAllRange.replace("{range}", range) : a().emptyAll;
  };
  const whatLabel = (action: HistoryAction) => a()[`what.${action}`];
  const exportHistory = () =>
    void openExportHistoryDialog({
      title: a().exportTitle,
      filters: props.filters,
      bases: props.bases,
      baseLabels: labels(),
      loadBases: props.loadBases,
      people: people(),
      whatLabel,
      now: props.env.now,
    });

  const columns = [
    { id: "time", header: () => a().columnTime, nowrap: true },
    { id: "who", header: () => a().columnWho },
    { id: "what", header: () => a().columnWhat },
    { id: "item", header: () => a().columnItem },
    { id: "base", header: () => a().columnBase },
    { id: "channel", header: () => a().columnChannel },
  ];
  const cell = (row: HistoryRowModel, column: string) => {
    const entry = row.lead;
    switch (column) {
      case "time":
        return (
          <time class="text-muted tabular-nums" datetime={entry.time}>
            {adminTime(entry, locale(), env())}
          </time>
        );
      case "who": {
        const actor = actorOf(entry, h(), env());
        return (
          <span class="flex min-w-0 items-center gap-2 font-medium text-[var(--k2b-text)]">
            {/* Decorative like Activity's avatar; the cell names the actor. Approved table avatars are 22 px. */}
            <span class="flex shrink-0" aria-hidden="true">
              <Avatar
                name={actor.kind === "person" ? actor.label : (actor.agent ?? actor.label)}
                icon={actor.icon ?? undefined}
                size="xs"
                style={{
                  width: "22px",
                  height: "22px",
                  ...(actor.kind === "observed" ? { background: "var(--k2b-warning-surface)", color: "var(--k2b-warning-text)" } : {}),
                }}
              />
            </span>
            <span class="truncate">{adminWho(entry, h(), a(), env())}</span>
          </span>
        );
      }
      case "what": {
        const status = statusOf(entry, h());
        // A permanent deletion is the one change that cannot be undone; it reads as a warning tag like the approved table.
        if (!status && entry.action === "item.purge") return <StatusBadge tone="error" label={adminWhat(row, a())} />;
        return (
          <span class="flex items-center gap-1.5">
            <Show when={status}>{(current) => <StatusBadge tone={current().tone} icon={current().icon} label={current().label} />}</Show>
            <span>{adminWhat(row, a())}</span>
          </span>
        );
      }
      case "item": {
        const name = adminItem(row, a());
        return (
          <span class="block max-w-[18rem] truncate font-medium text-[var(--k2b-text)]" title={name ?? undefined}>
            {name ?? "–"}
          </span>
        );
      }
      case "base": {
        const base = entryBase(entry, byBinding());
        const label = base ? adminBaseLabel(base, a(), locale()) : labelsLoading() ? a().basesLoading : a().unknownBase;
        return (
          <span class="block max-w-[14rem] truncate" title={label}>
            {label}
          </span>
        );
      }
      default:
        return <span class="text-muted">{adminChannel(entry, h(), a(), env()) ?? "–"}</span>;
    }
  };

  return (
    <section class="filesv2-history @container" aria-label={a().tableLabel}>
      <Show when={labelsFailed()}>
        <InlineGuidance role="alert" tone="danger">
          {a().basesFailed}
          <Button size="sm" variant="secondary" onClick={() => setRetryLabels((value) => value + 1)}>
            {a().retry}
          </Button>
        </InlineGuidance>
      </Show>
      <Show when={labelsLoading()}>
        <span class="sr-only" role="status">
          {a().basesLoading}
        </span>
      </Show>
      <div class="filesv2-history-head">
        <TextInput
          type="search"
          icon="ti ti-search"
          class="filesv2-history-search"
          placeholder={h().searchPlaceholder}
          aria-label={h().searchLabel}
          maxLength={ADMIN_SEARCH_LIMIT}
          value={text()}
          onValueChange={setText}
          onSubmit={() => change({ q: text().trim() || undefined })}
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
            onValueChange={(value) => void chooseBase(value)}
            options={[{ options: [...baseOptions(), { value: "search-bases", label: a().baseSearchMore }] }]}
          />
          <FilterChip
            label={h().filterWho}
            icon="ti ti-user"
            showValue
            value={props.filters.actor ? [props.filters.actor] : []}
            onValueChange={(value) => change({ actor: single(value) })}
            options={[{ options: peopleOptions() }]}
          />
          <FilterChip
            label={h().filterWhat}
            icon="ti ti-activity"
            showValue
            value={props.filters.action ? [props.filters.action] : []}
            onValueChange={(value) => change({ action: single(value) as HistoryAction | undefined })}
            options={[{ options: WHAT.map((action) => ({ value: action, label: whatLabel(action) })) }]}
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
            <Button size="sm" variant="text" onClick={resetFilters}>
              {h().reset}
            </Button>
          </Show>
        </div>
        <div class="filesv2-history-head__actions">
          <Button size="sm" variant="secondary" onClick={exportHistory}>
            <i class="ti ti-download" aria-hidden="true" />
            {a().exportButton}
          </Button>
        </div>
      </div>
      <div class="filesv2-history-body" aria-busy={pages.loading() || pages.refreshing()}>
        <Switch>
          <Match when={!loadedOnce() && pages.error()}>
            <Placeholder
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
            <div class="filesv2-admin-history-table" aria-hidden="true">
              <For each={Array.from({ length: 9 }, (_, index) => index)}>{() => <Skeleton class="my-3 h-5 w-full" />}</For>
            </div>
            <div class="filesv2-history-list filesv2-admin-history-list">
              <Skeleton class="filesv2-history-skeleton__day" />
              <SkeletonRows count={4} variant="list" />
              <Skeleton class="filesv2-history-skeleton__day" />
              <SkeletonRows count={3} variant="list" />
            </div>
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
              state={filtered() || props.filters.q ? "no-results" : "empty"}
              icon="ti ti-history"
              title={filtered() || props.filters.q ? h().emptyTitle : h().noActivityTitle}
              description={filtered() || props.filters.q ? emptyText() : h().noActivityText}
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
            <div class="filesv2-admin-history-table">
              <DataTable
                rows={rows()}
                columns={columns}
                getRowId={(row) => row.key}
                ariaLabel={a().tableLabel}
                surface="plain"
                verticalAlign="middle"
                renderCell={({ row, col }) => cell(row, col.id)}
              />
            </div>
            <div class="filesv2-history-list filesv2-admin-history-list">
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
                            <HistoryRow row={row} env={env()} context="activity" dated variant="list" />
                          </li>
                        )}
                      </For>
                    </ul>
                  </section>
                )}
              </For>
            </div>
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
    </section>
  );
}
