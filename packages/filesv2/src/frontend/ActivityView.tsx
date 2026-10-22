import { startOfDay } from "@k2b/stdlib";
import { query } from "@k2b/stdlib/solid";
import {
  Avatar,
  Button,
  Dropdown,
  FilterChip,
  InlineGuidance,
  Placeholder,
  prompts,
  Skeleton,
  StatusBadge,
  TextInput,
  toast,
  useLocale,
} from "@k2b/ui";
import { createEffect, createMemo, createSignal, createUniqueId, For, type JSX, Match, on, Show, Switch } from "solid-js";
import type { ActivityBatchContext, ActivityChain, ActivityEntry, ActivityInput, ActivityPage, HistoryAction } from "../activity-contracts";
import {
  type ActorView,
  actorOf,
  dayGroups,
  type HistoryActions,
  type HistoryEnvironment,
  type HistoryRowModel,
  historyRows,
  isDirectory,
  type MetaPart,
  metaParts,
  type Part,
  type RestoreOutcome,
  type RowAction,
  rowAction,
  type SentenceContext,
  sentence,
  subjectName,
} from "./history-actions";
import { type HistoryMessages, useHistoryMessages } from "./history-messages";
import MissingItemView from "./MissingItemView";

/* ------------------------------------------------------------------ shared row parts */

export function PlacePath(props: { segments: readonly string[] }) {
  return (
    <span class="filesv2-history-path">
      <For each={props.segments}>
        {(segment, index) => (
          <>
            <Show when={index() > 0}>
              <span class="filesv2-history-path__sep"> › </span>
            </Show>
            {segment}
          </>
        )}
      </For>
    </span>
  );
}

export function Sentence(props: { parts: readonly Part[] }) {
  return (
    <For each={props.parts}>
      {(part) =>
        part.kind === "name" ? <strong>{part.text}</strong> : part.kind === "place" ? <PlacePath segments={part.segments} /> : part.text
      }
    </For>
  );
}

/** Approved avatar sizes: 30 px in lists, 26 px in the detail. The nearest public size only sets the type scale. */
const AVATAR_PX = { xs: 26, sm: 30 } as const;

/** The actor's avatar is decorative: the sentence names the actor. A finding without a Cloud entry reads as a warning. */
export function HistoryAvatar(props: { actor: ActorView; size: "xs" | "sm" }) {
  const px = () => `${AVATAR_PX[props.size]}px`;
  return (
    <span class="filesv2-history-row__who" data-actor={props.actor.kind} aria-hidden="true">
      <Avatar
        name={props.actor.kind === "person" ? props.actor.label : (props.actor.agent ?? props.actor.label)}
        icon={props.actor.icon ?? undefined}
        size={props.size}
        style={{
          width: px(),
          height: px(),
          ...(props.actor.kind === "observed" ? { background: "var(--k2b-warning-surface)", color: "var(--k2b-warning-text)" } : {}),
        }}
      />
    </span>
  );
}

export function MetaLine(props: { parts: readonly MetaPart[] }) {
  return (
    <p class="filesv2-history-row__meta">
      <For each={props.parts}>
        {(part, index) => (
          <>
            <Show when={index() > 0 && props.parts[index() - 1]?.kind !== "status"}>
              <span class="filesv2-history-row__dot" aria-hidden="true">
                ·
              </span>
            </Show>
            <Switch>
              <Match when={part.kind === "status" && part}>
                {(status) => (
                  <StatusBadge
                    class="filesv2-history-row__status"
                    tone={status().tone === "running" ? "running" : status().tone}
                    icon={status().icon}
                    label={status().label}
                  />
                )}
              </Match>
              <Match when={part.kind === "time" && part}>{(time) => <time datetime={time().iso}>{time().text}</time>}</Match>
              <Match when={part.kind === "link" && part}>
                {(link) => (
                  <a class="filesv2-history-link" href={link().href}>
                    {link().label}
                  </a>
                )}
              </Match>
              <Match when={part.kind === "text" && part}>{(item) => <span>{item().text}</span>}</Match>
            </Switch>
          </>
        )}
      </For>
    </p>
  );
}

/**
 * Restores a trashed item to its old place. When something with the same name is there by now, asks for a new name
 * and tries again; cancelling leaves the item in the trash.
 */
export async function restoreFromTrash(
  entry: ActivityEntry,
  restore: (entry: ActivityEntry, options?: { name: string }) => Promise<RestoreOutcome>,
  h: HistoryMessages,
): Promise<void> {
  const name = subjectName(entry) ?? "";
  let outcome = await restore(entry);
  while (outcome.status === "name_conflict") {
    const values = await prompts.form({
      title: h.conflictTitle,
      icon: "ti ti-arrow-back-up",
      confirmText: h.restoreItem,
      fields: {
        name: {
          type: "text",
          label: h.newName,
          description: h.conflictText,
          default: `${name} ${h.restoredCopy}`,
          required: true,
          maxLength: 255,
        },
      },
    });
    if (!values) return;
    outcome = await restore(entry, { name: String(values.name) });
  }
  toast.success(h.restored.replace("{name}", name));
}

/** Runs one row action, keeps the row's button busy, and leaves a visible error beside the row on failure. */
export function useRowAction(onChanged?: () => void) {
  const h = useHistoryMessages();
  const [pending, setPending] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const run = async (action: RowAction) => {
    if (pending()) return;
    setPending(true);
    setError(null);
    try {
      await action.run();
      onChanged?.();
    } catch (caught) {
      setError(caught instanceof Error && caught.message ? caught.message : h().actionFailed);
    } finally {
      setPending(false);
    }
  };
  return { pending, error, run };
}

export type HistoryRowProps = {
  row: HistoryRowModel;
  env: HistoryEnvironment;
  actions?: HistoryActions;
  context: SentenceContext;
  /** Rows under a day heading show the time alone. */
  dated: boolean;
  /** List rows reveal their action on hover and focus; detail rows always show it below the sentence. */
  variant: "list" | "detail";
  directory?: boolean;
  /** Replaces the sentence or meta for rows that describe a state instead of a change. */
  sentence?: readonly Part[];
  meta?: readonly MetaPart[];
  action?: RowAction | null;
  others?: number;
  onChanged?: () => void;
};

/** One activity row: who, one sentence, quiet facts, at most one action, and the visible members of a batch. */
export function HistoryRow(props: HistoryRowProps) {
  const h = useHistoryMessages();
  const locale = useLocale();
  const actor = createMemo(() => actorOf(props.row.lead, h(), props.env));
  const parts = createMemo(
    () => props.sentence ?? sentence(props.row, h(), props.env, { context: props.context, directory: props.directory }),
  );
  const meta = createMemo(
    () =>
      props.meta ??
      metaParts(props.row, h(), locale(), props.env, {
        context: props.context,
        dated: props.dated,
        actions: props.actions,
        others: props.others,
      }),
  );
  const action = createMemo(() => {
    const chosen = props.action !== undefined ? props.action : rowAction(props.row, h(), props.actions ?? {});
    const trashed = chosen?.restoresTrash;
    const restore = props.actions?.onRestoreTrash;
    return trashed && restore ? { ...chosen, run: () => restoreFromTrash(trashed, restore, h()) } : chosen;
  });
  const runner = useRowAction(() => props.onChanged?.());
  const [expanded, setExpanded] = createSignal(false);
  const membersId = `filesv2-history-members-${createUniqueId()}`;
  const members = () => (props.row.kind === "batch" ? props.row.entries : []);
  const shown = () => (expanded() ? members() : members().slice(0, 3));
  return (
    <article class="filesv2-history-row" data-variant={props.variant} data-state={props.row.lead.state}>
      <HistoryAvatar actor={actor()} size={props.variant === "detail" ? "xs" : "sm"} />
      <div class="filesv2-history-row__text">
        <p class="filesv2-history-row__sentence">
          <Sentence parts={parts()} />
        </p>
        <MetaLine parts={meta()} />
        <Show when={members().length > 0}>
          <ul id={membersId} class="filesv2-history-row__members">
            <For each={shown()}>
              {(member: ActivityEntry) => (
                <li>
                  <i class={isDirectory(member) ? "ti ti-folder" : "ti ti-file"} aria-hidden="true" />
                  <span class="filesv2-history-row__member-name">{subjectName(member)}</span>
                </li>
              )}
            </For>
          </ul>
          <Show when={members().length > 3}>
            <Button
              size="xs"
              variant="text"
              class="filesv2-history-row__more"
              aria-expanded={expanded()}
              aria-controls={membersId}
              onClick={() => setExpanded(!expanded())}
            >
              <i class={expanded() ? "ti ti-chevron-up" : "ti ti-chevron-down"} aria-hidden="true" />
              {expanded() ? h().fewerItems : h().moreItems.replace("{count}", String(members().length - 3))}
            </Button>
          </Show>
        </Show>
        <Show when={runner.error()}>
          {(message) => (
            <p class="filesv2-history-row__error" role="alert">
              {message()}
            </p>
          )}
        </Show>
      </div>
      <div class="filesv2-history-row__action" data-keep={runner.pending() || runner.error() ? "" : undefined}>
        <Show when={action()}>
          {(current) => (
            <Button size="sm" variant="secondary" loading={runner.pending()} onClick={() => void runner.run(current())}>
              <i class={current().icon} aria-hidden="true" />
              {current().label}
            </Button>
          )}
        </Show>
      </div>
    </article>
  );
}

/** Placeholder rows with the height of real rows, so loading never shifts the list. */
export function SkeletonRows(props: { count: number; variant: "list" | "detail" }) {
  return (
    <For each={Array.from({ length: props.count }, (_, index) => index)}>
      {() => (
        <div class="filesv2-history-row filesv2-history-row--skeleton" data-variant={props.variant} aria-hidden="true">
          <Skeleton class="filesv2-history-skeleton__who" />
          <div class="filesv2-history-row__text">
            <Skeleton class="filesv2-history-skeleton__line" />
            <Skeleton class="filesv2-history-skeleton__meta" />
          </div>
        </div>
      )}
    </For>
  );
}

/* ------------------------------------------------------------------ activity view */

export type ActivityWhen = "today" | "7" | "30" | "365";
/** URL state of the Activity view; the parent keeps it in the address so reload and back restore it. */
export type ActivityFilters = {
  baseId?: string;
  /** A base-relative item or folder path; "All in Activity" preserves its scope. */
  path?: string;
  scope?: ActivityInput["scope"];
  actor?: string;
  action?: HistoryAction;
  when?: ActivityWhen;
  q?: string;
};
export type ActivityRequest = Omit<ActivityInput, "itemId" | "limit">;

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
const DAYS: Record<ActivityWhen, number> = { today: 0, "7": 7, "30": 30, "365": 365 };

/** Start of the range in the request's zone. "Today" starts at local midnight. */
export function rangeStart(when: ActivityWhen, env: HistoryEnvironment): string {
  const now = new Date(env.now);
  if (when !== "today") return new Date(now.getTime() - DAYS[when] * 86_400_000).toISOString();
  return startOfDay(now, { timeZone: env.timeZone }).toISOString();
}

export function activityRequest(filters: ActivityFilters, env: HistoryEnvironment): ActivityRequest {
  return {
    ...(filters.baseId ? { baseId: filters.baseId } : {}),
    ...(filters.baseId && filters.path !== undefined ? { path: filters.path, scope: filters.scope ?? "item" } : {}),
    ...(filters.actor ? { actor: filters.actor } : {}),
    ...(filters.action ? { action: filters.action } : {}),
    ...(filters.when ? { from: rangeStart(filters.when, env) } : {}),
    ...(filters.q ? { q: filters.q } : {}),
  };
}
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
            <Button size="sm" variant="text" onClick={resetFilters}>
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
          when={!props.filters.q}
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

/** End of a loaded list: older pages, a failed page with retry, or the search limit. */
export function MoreFooter(props: { hasMore: boolean; loadingMore: boolean; failed: boolean; limitReached: boolean; onMore: () => void }) {
  const h = useHistoryMessages();
  return (
    <div class="filesv2-history-more">
      <Show when={props.failed}>
        <InlineGuidance tone="danger" role="alert">
          {h().olderFailed}
        </InlineGuidance>
      </Show>
      <Show when={props.hasMore || props.failed}>
        <Button size="sm" variant="text" loading={props.loadingMore} loadingLabel={h().loadingOlder} onClick={props.onMore}>
          <i class={props.failed ? "ti ti-refresh" : "ti ti-chevron-down"} aria-hidden="true" />
          {props.failed ? h().retry : h().loadOlder}
        </Button>
      </Show>
      <Show when={props.limitReached}>
        <InlineGuidance tone="info">{h().searchLimit}</InlineGuidance>
      </Show>
    </div>
  );
}
