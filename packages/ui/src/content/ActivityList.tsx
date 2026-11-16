import type { DateContext } from "@k2b/stdlib";
import { createMemo, createSignal, For, type JSX, onCleanup, onMount, Show } from "solid-js";
import { Button } from "../actions/Button";
import { InlineGuidance } from "../feedback/InlineGuidance";
import { prompts } from "../feedback/prompts";
import { ChoiceChips } from "../inputs/ChoiceChips";
import { useDateConfigLocale } from "../intl/locale";
import { Section } from "../surfaces/Section";
import { Skeleton } from "../surfaces/Skeleton";
import { resolveActivityMessages, useActivityMessages } from "./activity-messages";
import { type ActivityGroup, type ActivityRow, activityAgo, activityDayLabel, activityInstant, activityRows, activityWhen } from "./activity-timeline";

/** Only the icon carries a tone: grey by default, green for a completion, amber for a notice, red only while an action is needed. */
export type ActivityTone = "neutral" | "success" | "warning" | "danger";

/** At most one action per entry, a link with an icon in the last line, only while the state needs it. */
export type ActivityAction = {
  icon: string;
  label: string;
  /** A link when set and not disabled; otherwise a button. */
  href?: string;
  target?: string;
  onClick?: (event: MouseEvent) => void;
  disabled?: boolean;
  /** For tests: rendered as `data-activity-action`. */
  data?: string;
};

export type ActivityEntry = {
  /**
   * Stable key of the entry, such as its record id; unique within the list. With it a row keeps its node, folded-out
   * details, and focus when the caller rebuilds the entries, such as after a refresh. Without it the entry object is
   * the key.
   */
  id?: string;
  /** ISO instant. */
  at: string;
  /** Icon class of the kind, such as `ti ti-mail`; one fixed icon per kind. */
  icon: string;
  tone?: ActivityTone;
  /** Name of the icon for tooltip and screen readers, when the sentence does not say it already. */
  iconLabel?: string;
  /** One sentence, such as "Invitation sent". */
  text: JSX.Element;
  /**
   * Equal entries (one key) after each other on the same day become one row; `text` says it with the count
   * ("Draft changed 4 times") and gets every entry of the bundle, newest first. A bundle keeps the detail line only
   * when it is the same text for all entries.
   */
  bundle?: { key: string; text: (count: number, all: readonly ActivityEntry[]) => JSX.Element } | null;
  /** Only a result, the reason of a failure, a quote, or "before → now" (`ActivityList.Change`). */
  detail?: JSX.Element;
  /** Who did it, a text of the application; without one the meta line reads "automatic". */
  actor?: JSX.Element | null;
  action?: ActivityAction | null;
  /** A click on the entry opens it, such as its dialog. */
  onOpen?: () => void;
  /**
   * The entry's object as a link: the sentence becomes the link, a click anywhere on the row follows it, and a middle
   * click or a click with Ctrl, Cmd, or Shift opens it in a new tab. Takes the place of `onOpen`; ignored with
   * `details`.
   */
  href?: string;
  /** A click on the entry folds out its details below it; for a bundle with all of its entries. */
  details?: (all: readonly ActivityEntry[]) => JSX.Element;
  /** Kind for the filter in the "All N" dialog. */
  kind?: string;
  /** Attributes on the list item, such as `data-email` for focus after a reload. */
  attrs?: Record<`data-${string}`, string | number | undefined>;
};

/** `compact` for a card or side column (meta under the sentence); `wide` for a dialog or page (meta on the right). */
export type ActivityDensity = "compact" | "wide";

type ActivityTimeProps = {
  /**
   * The current time. Pass the server's time so the server and the first browser render show the same text; the
   * browser then moves it on every minute.
   */
  now?: Date | string;
  /** Date context of the application; days count in its time zone. */
  dateConfig?: DateContext;
  /** Convenience override for `dateConfig.timeZone`. Defaults to UTC, so server and browser agree. */
  timeZone?: string;
};

export type ActivityListProps = ActivityTimeProps & {
  entries: readonly ActivityEntry[];
  density?: ActivityDensity;
  /** Shows only the newest rows; the rail then fades out below them. */
  limit?: number;
  /** More follows below the last visible row (further pages from the server); the rail fades out. */
  more?: boolean;
  /** Accessible name of the list. Defaults to "History". */
  label?: string;
  class?: string;
};

/** Bundle key of an entry: its bundle key and its actor; without `bundle` never bundled. */
const activityBundleKey = (entry: ActivityEntry): string | null =>
  entry.bundle ? `${entry.bundle.key}|${typeof entry.actor === "string" ? entry.actor : ""}` : null;

/** The list's clock: first `start` (from the server, the same first render), then in the browser every minute anew. */
const createNow = (start: () => Date | string | undefined) => {
  const initial = start();
  const [now, setNow] = createSignal(initial ? new Date(initial) : new Date());
  onMount(() => {
    setNow(new Date());
    const timer = setInterval(() => setNow(new Date()), 60_000);
    onCleanup(() => clearInterval(timer));
  });
  return now;
};

const useActivityContext = (props: ActivityTimeProps) => {
  const context = useDateConfigLocale(() => props.dateConfig);
  return {
    locale: () => context().locale ?? "en",
    timeZone: () => props.timeZone ?? props.dateConfig?.timeZone ?? "UTC",
  };
};

/** The key a row hangs on: the entry's `id`, or the entry object itself. */
const rowKey = (entry: ActivityEntry): string | ActivityEntry => entry.id ?? entry;

/** Two bundles are the same when they hold the same entries in the same order. */
const sameEntries = (a: readonly ActivityEntry[], b: readonly ActivityEntry[]): boolean =>
  a.length === b.length && a.every((entry, index) => entry === b[index]);

/** A click that must not act on the row: on a control inside it, inside folded-out details, or the end of a text selection. */
const ignoresRowClick = (event: MouseEvent): boolean =>
  Boolean((event.target as Element | null)?.closest("a, button, input, textarea, select, label, [role=button], .k2b-activity__details")) ||
  window.getSelection()?.isCollapsed === false;

/** Text of a detail line when it is only text; JSX cannot be compared. */
const detailText = (detail: JSX.Element | undefined): string | null => (typeof detail === "string" ? detail : null);

const TONES: Record<ActivityTone, string | undefined> = { neutral: undefined, success: "success", warning: "warning", danger: "danger" };

/**
 * A vertical timeline: newest at the top, the start at the bottom. Dashed dividers name "Today", "Yesterday", and
 * each day of the last week; everything older stands under one divider "More than a week ago".
 *
 * A row: the icon of the kind (20 px, grey, without a circle; only the icon carries a tone), one sentence, and the
 * meta line "time · distance · person" ("automatic" without a person). Rarely a detail line below, and at most one
 * action. Equal entries after each other on the same day become one row with a count (`bundle`). Every row hangs on
 * its newest entry (its `id`, or the object): the minute clock changes only times and dividers, folded-out details,
 * bundle sentences, and focus stay.
 */
function ActivityListRoot(props: ActivityListProps): JSX.Element {
  const t = useActivityMessages();
  const context = useActivityContext(props);
  const now = createNow(() => props.now);
  // Read the entries apart from the clock: a caller that builds them in a getter does not rebuild them every minute.
  const list = createMemo(() => props.entries);
  const allRows = createMemo(() => activityRows(list(), { now: now(), timeZone: context.timeZone(), key: activityBundleKey }));
  const rows = createMemo(() => (props.limit ? allRows().slice(0, props.limit) : allRows()));
  const rowOf = createMemo(() => new Map(rows().map((row) => [rowKey(row.entry), row] as const)));
  const keys = createMemo(() => rows().map((row) => rowKey(row.entry)));
  const fades = () => props.more === true || (props.limit !== undefined && allRows().length > props.limit);
  const divider = (group: ActivityGroup) =>
    group.kind === "today"
      ? t().activityToday
      : group.kind === "yesterday"
        ? t().activityYesterday
        : group.kind === "older"
          ? t().activityOlder
          : activityDayLabel(group.day, now(), context.locale(), context.timeZone());
  return (
    <ol
      class={props.class ? `k2b-activity ${props.class}` : "k2b-activity"}
      data-density={props.density ?? "compact"}
      aria-label={props.label ?? t().activityTitle}
    >
      <For each={keys()}>
        {(key, index) => {
          // `keys` and `rowOf` come from the same rows, so the key has its row; while a removed key is disposed the
          // row keeps its last value.
          const initial = rowOf().get(key);
          if (!initial) throw new Error("ActivityList: a row key without its row.");
          const row = createMemo((previous: ActivityRow<ActivityEntry>) => rowOf().get(key) ?? previous, initial);
          // The clock rebuilds the rows every minute; the entry and its bundle change only when their entries do, so a
          // bundle sentence and folded-out details keep their nodes.
          const entry = createMemo(() => row().entry);
          const all = createMemo(() => row().all, undefined, { equals: sameEntries });
          const last = () => index() === rows().length - 1;
          return (
            <>
              <Show when={row().divider}>
                {(group) => (
                  <li class="k2b-activity__day" aria-hidden="true">
                    <span class="k2b-activity__day-line" />
                    {divider(group())}
                  </li>
                )}
              </Show>
              <ActivityRowItem
                entry={entry()}
                all={all()}
                now={now()}
                first={index() === 0}
                end={last() ? (fades() ? "more" : "last") : undefined}
                wide={props.density === "wide"}
                locale={context.locale()}
                timeZone={context.timeZone()}
              />
            </>
          );
        }}
      </For>
    </ol>
  );
}

function ActivityRowItem(props: {
  entry: ActivityEntry;
  all: readonly ActivityEntry[];
  now: Date;
  first: boolean;
  end: "last" | "more" | undefined;
  wide: boolean;
  locale: string;
  timeZone: string;
}): JSX.Element {
  const t = useActivityMessages();
  const [open, setOpen] = createSignal(false);
  const e = () => props.entry;
  const count = () => props.all.length;
  const bundled = () => (count() > 1 ? e().bundle : null);
  const text = () => {
    const bundle = bundled();
    return bundle ? bundle.text(count(), props.all) : e().text;
  };
  // A bundle keeps the detail line only when every entry has the same text.
  const detail = () =>
    count() === 1 || props.all.every((entry) => detailText(entry.detail) !== null && detailText(entry.detail) === detailText(e().detail))
      ? e().detail
      : undefined;
  const href = () => (e().details ? undefined : e().href);
  const clickable = () => Boolean(e().onOpen || e().details || href());
  // Folds out the details, or opens the entry.
  const trigger = () => {
    if (e().details) setOpen(!open());
    else e().onOpen?.();
  };
  let link: HTMLAnchorElement | undefined;
  // A click anywhere on the row acts like the sentence, but not on controls, inside folded-out details, or after
  // selecting text. A linked row follows its link; with a modifier or the middle button in a new tab, as the link would.
  const onRowClick = (event: MouseEvent) => {
    if (!clickable() || ignoresRowClick(event)) return;
    const target = href();
    if (!target) return trigger();
    if (event.button === 1 || event.ctrlKey || event.metaKey || event.shiftKey) window.open(target, "_blank", "noopener");
    else link?.click();
  };
  const meta = () => (
    <div class="k2b-activity__meta">
      <time datetime={e().at} title={activityInstant(e().at, props.locale, props.timeZone)}>
        {activityWhen(e().at, props.now, props.locale, props.timeZone)}
      </time>
      {" · "}
      {activityAgo(e().at, props.now, props.locale, props.timeZone)}
      {" · "}
      {e().actor ?? t().activityAutomatic}
    </div>
  );
  const action = () => {
    const current = e().action;
    if (!current) return null;
    const content = (
      <>
        <i class={current.icon} aria-hidden="true" />
        {current.label}
      </>
    );
    return current.href && !current.disabled ? (
      <a
        class="k2b-activity__action"
        href={current.href}
        target={current.target}
        rel={current.target ? "noopener" : undefined}
        onClick={(event) => current.onClick?.(event)}
        data-activity-action={current.data}
      >
        {content}
      </a>
    ) : (
      <button
        type="button"
        class="k2b-activity__action"
        disabled={current.disabled}
        onClick={(event) => current.onClick?.(event)}
        data-activity-action={current.data}
      >
        {content}
      </button>
    );
  };
  return (
    // tabindex -1: the target for focus after a reload, never in the tab order.
    // biome-ignore lint/a11y/useKeyWithClickEvents: the sentence's own button is the keyboard target; a row click only widens the pointer target.
    <li
      {...e().attrs}
      tabindex="-1"
      class="k2b-activity__entry"
      data-first={props.first ? "" : undefined}
      data-end={props.end}
      data-clickable={clickable() ? "" : undefined}
      data-count={count() > 1 ? count() : undefined}
      onClick={onRowClick}
      onAuxClick={(event) => {
        if (event.button === 1 && href()) onRowClick(event);
      }}
    >
      <span class="k2b-activity__icon" data-tone={TONES[e().tone ?? "neutral"]}>
        {/* biome-ignore lint/a11y/useAriaPropsSupportedByRole: with a label the icon is an image (`role="img"`), which takes a name. */}
        <i
          class={e().icon}
          role={e().iconLabel ? "img" : undefined}
          aria-label={e().iconLabel}
          aria-hidden={e().iconLabel ? undefined : "true"}
          title={e().iconLabel}
        />
      </span>
      <div class="k2b-activity__body">
        <div class="k2b-activity__text">
          <Show when={clickable()} fallback={text()}>
            <Show
              when={href()}
              fallback={
                <button
                  type="button"
                  class="k2b-activity__text-button"
                  aria-expanded={e().details ? open() : undefined}
                  onClick={(event) => {
                    event.stopPropagation();
                    trigger();
                  }}
                >
                  {text()}
                </button>
              }
            >
              {(target) => (
                <a ref={link} class="k2b-activity__text-link" href={target()}>
                  {text()}
                </a>
              )}
            </Show>
          </Show>
        </div>
        <Show when={detail()}>
          <div class="k2b-activity__detail">{detail()}</div>
        </Show>
        <Show when={!props.wide}>{meta()}</Show>
        <Show when={e().action}>
          <div>{action()}</div>
        </Show>
        <Show when={open() && e().details}>{(show) => <div class="k2b-activity__details">{show()(props.all)}</div>}</Show>
      </div>
      <Show when={props.wide}>{meta()}</Show>
    </li>
  );
}

/** "before → now" of a detail line, the old value quiet. With `term` in front ("Plan: Basic → Team"). */
function ActivityChange(props: { before: JSX.Element; now: JSX.Element; term?: string }): JSX.Element {
  return (
    <>
      {props.term ? `${props.term}: ` : ""}
      <span class="k2b-activity__before">{props.before}</span>
      {" → "}
      {props.now}
    </>
  );
}

const LOADING_WIDTHS = [150, 110, 170] as const;

/** Loading: three quiet rows on the rail, announced to screen readers. */
function ActivityLoading(props: { label?: string }): JSX.Element {
  const t = useActivityMessages();
  return (
    <div role="status" aria-label={props.label ?? t().activityTitle}>
      <ol class="k2b-activity" aria-hidden="true">
        <For each={LOADING_WIDTHS}>
          {(width, index) => (
            <li
              class="k2b-activity__entry"
              data-first={index() === 0 ? "" : undefined}
              data-end={index() === LOADING_WIDTHS.length - 1 ? "last" : undefined}
            >
              <span class="k2b-activity__icon" data-placeholder="" />
              <div class="k2b-activity__placeholder">
                <div style={{ width: `${width}px` }}>
                  <Skeleton class="k2b-activity__placeholder-line" />
                </div>
                <div style={{ width: "120px" }}>
                  <Skeleton class="k2b-activity__placeholder-meta" />
                </div>
              </div>
            </li>
          )}
        </For>
      </ol>
    </div>
  );
}

/** Error: one sentence with "Reload". */
function ActivityError(props: { onReload?: () => void; text?: JSX.Element }): JSX.Element {
  const t = useActivityMessages();
  return (
    <InlineGuidance tone="warning" icon="ti ti-alert-triangle" role="alert">
      {props.text ?? t().activityError}{" "}
      <Show when={props.onReload}>
        {(reload) => (
          <button type="button" class="k2b-activity__reload" onClick={() => reload()()}>
            {t().activityReload}
          </button>
        )}
      </Show>
    </InlineGuidance>
  );
}

/** Empty: one sentence. */
function ActivityEmpty(props: { text?: JSX.Element }): JSX.Element {
  const t = useActivityMessages();
  return <p class="k2b-activity-empty">{props.text ?? t().activityEmpty}</p>;
}

type ActivityListComponent = ((props: ActivityListProps) => JSX.Element) & {
  Loading: typeof ActivityLoading;
  Empty: typeof ActivityEmpty;
  Error: typeof ActivityError;
  Change: typeof ActivityChange;
};

export const ActivityList: ActivityListComponent = Object.assign(ActivityListRoot, {
  Loading: ActivityLoading,
  Empty: ActivityEmpty,
  Error: ActivityError,
  Change: ActivityChange,
});

/** Newest rows a card shows; "All N" opens the rest. */
const ACTIVITY_CARD_LIMIT = 6;

/** A kind for the filter of the "All N" dialog; only kinds with entries appear. */
export type ActivityKind = { key: string; label: string };

export type ActivityDialogInput = ActivityTimeProps & {
  /** Read on open; build the entries in the getter, so the dialog gets nodes of its own. */
  entries: () => readonly ActivityEntry[];
  /** Defaults to "History". */
  title?: string;
  /** Second line, such as the object the history belongs to. */
  subtitle?: string;
  kinds?: readonly ActivityKind[];
  /** Shown when there are no entries; defaults to "Nothing has happened yet.". */
  emptyText?: JSX.Element;
};

export type ActivityCardProps = ActivityTimeProps & {
  /** `null`: nothing loaded yet (loading or error). */
  entries: readonly ActivityEntry[] | null;
  /** Rows the card shows. Defaults to 6. */
  limit?: number;
  loading?: boolean;
  error?: boolean;
  onReload?: () => void;
  emptyText?: JSX.Element;
  /** Defaults to "History". */
  title?: string;
  /** Heading level of the title; 2 by default, 3 for a card under a section heading of the page. */
  level?: 2 | 3;
  /** Second line in the "All N" dialog, such as "Invoice RE-2610-00042 · Lindner". */
  subtitle?: string;
  /** Filter by kind in the dialog; only kinds with entries appear. */
  kinds?: readonly ActivityKind[];
  /** More at the end of the heading, before "All N", such as "reloading". */
  actions?: JSX.Element;
  /** Above the timeline, such as a quiet line "Waiting for approval"; replaces the empty text. */
  lead?: JSX.Element;
  /** For tests: rendered as `data-activity-card`. */
  name?: string;
  id?: string;
};

/**
 * The history as a card of a detail page: a section with "History", and "All N" at the end of the heading when
 * there are more than `limit` rows; below it the list in the compact density. "All N" opens the full history as a
 * dialog in the wide density, with a filter by kind when `kinds` is set.
 *
 * Build `entries` in the getter (`entries={list()}` with a function, never from `createMemo`): sentence, detail, and
 * person are JSX, and card and dialog each need nodes of their own.
 */
export function ActivityCard(props: ActivityCardProps): JSX.Element {
  const t = useActivityMessages();
  const context = useActivityContext(props);
  const limit = () => props.limit ?? ACTIVITY_CARD_LIMIT;
  // Only times and keys count; no JSX needed, so the card's own list serves.
  const count = createMemo(
    () =>
      activityRows(props.entries ?? [], {
        now: props.now ? new Date(props.now) : new Date(),
        timeZone: context.timeZone(),
        key: activityBundleKey,
      }).length,
  );
  const openAll = () =>
    void openActivityDialog({
      entries: () => props.entries ?? [],
      title: props.title ?? t().activityTitle,
      subtitle: props.subtitle,
      kinds: props.kinds,
      now: props.now,
      dateConfig: props.dateConfig,
      timeZone: props.timeZone,
    });
  return (
    <Section
      size="md"
      level={props.level ?? 2}
      class="k2b-activity-card"
      title={props.title ?? t().activityTitle}
      icon="ti ti-history"
      id={props.id}
      data-activity-card={props.name}
      aria-busy={props.loading ? "true" : undefined}
      actions={
        <>
          {props.actions}
          <Show when={count() > limit()}>
            <Button variant="text" size="sm" class="k2b-activity-card__all" onClick={openAll} data-activity-all="">
              {t().activityAll({ count: count() })}
            </Button>
          </Show>
        </>
      }
    >
      <div class="k2b-activity-card__body">
        {props.lead}
        <Show
          when={props.entries}
          fallback={
            <Show when={props.error} fallback={<ActivityLoading label={props.title} />}>
              <ActivityError onReload={props.onReload} />
            </Show>
          }
        >
          {(list) => (
            <>
              <Show when={props.error}>
                <div class="k2b-activity-card__alert">
                  <ActivityError onReload={props.onReload} />
                </div>
              </Show>
              <Show when={list().length > 0} fallback={<Show when={!props.lead}>{<ActivityEmpty text={props.emptyText} />}</Show>}>
                <ActivityListRoot
                  entries={list()}
                  limit={limit()}
                  now={props.now}
                  dateConfig={props.dateConfig}
                  timeZone={props.timeZone}
                  label={props.title}
                />
              </Show>
            </>
          )}
        </Show>
      </div>
    </Section>
  );
}

/** The full history as a dialog: the title, the object below it, a filter by kind, and the list in the wide density. */
export const openActivityDialog = (input: ActivityDialogInput): Promise<void | undefined> =>
  prompts.dialog<void>(() => <ActivityDialogContent {...input} />, {
    title: input.title ?? resolveActivityMessages(input.dateConfig?.locale).activityTitle,
    size: "large",
  });

function ActivityDialogContent(props: ActivityDialogInput): JSX.Element {
  const t = useActivityMessages();
  const [kind, setKind] = createSignal("all");
  // The filter counts entries, not bundled rows, and appears only from three choices on.
  const total = (key: string) => props.entries().filter((entry) => key === "all" || entry.kind === key).length;
  const options = () => [
    { value: "all", label: t().activityAll({ count: total("all") }) },
    ...(props.kinds ?? [])
      .filter((item) => total(item.key) > 0)
      .map((item) => ({ value: item.key, label: `${item.label} ${total(item.key)}` })),
  ];
  const shown = () => props.entries().filter((entry) => kind() === "all" || entry.kind === kind());
  return (
    <div class="k2b-activity-dialog" data-activity-dialog="">
      <Show when={props.subtitle}>
        <p class="k2b-activity-dialog__subtitle">{props.subtitle}</p>
      </Show>
      <Show when={options().length > 2}>
        <ChoiceChips aria-label={t().activityFilter} value={kind()} options={options()} onValueChange={setKind} />
      </Show>
      <Show when={props.entries().length > 0} fallback={<ActivityEmpty text={props.emptyText} />}>
        <ActivityListRoot
          entries={shown()}
          density="wide"
          now={props.now}
          dateConfig={props.dateConfig}
          timeZone={props.timeZone}
          label={props.title}
        />
      </Show>
    </div>
  );
}
