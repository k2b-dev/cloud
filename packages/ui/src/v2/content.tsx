import { Link } from "@k2b/ssr/nav";
import {
  createComputed,
  createContext,
  createMemo,
  createSelector,
  createSignal,
  createUniqueId,
  For,
  type JSX,
  on,
  onCleanup,
  onMount,
  children as resolveChildren,
  Show,
  untrack,
  useContext,
} from "solid-js";
import { Dynamic } from "solid-js/web";
import { renderSafeMarkdown } from "../content/MarkdownView";
import { useLocale } from "../intl/locale";
import { useBehaviorMessages } from "./behavior/messages";
import { useGrip } from "./behavior/resize";
import { announceBranch, announceText, type TreegridRow, treegridStep } from "./behavior/treegrid";
import { ActionButton, CopyButton } from "./button";
import { MarkCheck } from "./controls";
import { linkOr } from "./link";
import { Avatar, custom, Dot, Icon, Mark, type MarkProps } from "./marks";
import { Empty, type EmptyProps, Loading, LoadingStatus, PlaceholderValue } from "./states";
import type { TypeRole } from "./tokens";
import { useTreeMessages } from "./tree-messages";
import { type Action, type OnNavigate, type Person, type Status, type Width, widthRange } from "./types";

// ── Text ─────────────────────────────────────────────────────────────────────────────────────────────────────────

export type TextProps = {
  /**
   * One of the four type roles. Without one, text takes the role of its place (13/20 in a pane, the role of the
   * sentence it stands in). (Named `type`, not `role`, so it never reads as an ARIA role.)
   */
  type?: TypeRole;
  /**
   * Emphasis is a weight, never a size: `strong` (600) stresses a word, `medium` (500) lets a state or an amount stand
   * out a little, such as "Quittung offen".
   */
  weight?: "medium" | "strong";
  /** The muted ink, for a second voice beside the main text. */
  muted?: boolean;
  /** A colour of meaning, never decoration. */
  tone?: Status | "ai" | "draft";
  /** The words lead to this page: they keep the ink of the text and are underlined (blue is only the main action). */
  href?: string;
  /**
   * Text a machine wrote, read sign by sign: a stack trace, a log message, a command. Monospace, and its line breaks
   * and spaces stay as written; a line longer than its place wraps at any sign. In the flow of a column it is a block.
   */
  mono?: boolean;
  /** The words. */
  children: JSX.Element;
};

const typeClass = { meta: "k2-t-meta", row: "k2-t-row", body: "k2-t-body", lead: "k2-t-lead" } as const;
const weightClass = { medium: "k2-medium", strong: "k2-strong" } as const;

/**
 * Text in one of the four type roles. Standing in the flow of a column (a pane, a band, a section, a group) it is a
 * block that carries the text edge itself; anywhere else (a bar, a row, a sentence) it runs inline, and in a bar it is
 * cut to one line with "…". The stylesheet decides by place, so text passed as data behaves the same.
 */
export const Text = (props: TextProps) => (
  <Dynamic
    component={props.href ? "a" : "span"}
    href={props.href}
    class={`k2-text${props.type ? ` ${typeClass[props.type]}` : ""}${props.weight ? ` ${weightClass[props.weight]}` : ""}${props.muted ? " k2-muted" : ""}${props.href ? " k2-link" : ""}`}
    data-k2-part="Text"
    data-type={props.type}
    data-tone={props.tone}
    data-mono={props.mono ? "" : undefined}
  >
    {props.children}
  </Dynamic>
);

/** The links reading text may carry; any other target shows as text. */
const proseLinks = ["https:", "http:", "mailto:"] as const;

export type ProseProps =
  | {
      /**
       * Text in Markdown, such as a message. Raw HTML in it shows as text; links lead only to web pages and mail
       * addresses; images show their words, they load nothing.
       */
      markdown: string;
      children?: never;
    }
  | {
      markdown?: never;
      /** Reading text as elements, when it is not Markdown. */
      children: JSX.Element;
    };

/** Reading text: 14/22, a measure of 720 px, headings at 16 and 18. It carries the text edge itself. */
export const Prose = (props: ProseProps) => {
  const locale = useLocale();
  return (
    <Show
      when={props.markdown !== undefined}
      fallback={
        <div class="k2-prose" data-k2-part="Prose" data-k2-prose="">
          {props.children}
        </div>
      }
    >
      <div
        class="k2-prose"
        data-k2-part="Prose"
        data-k2-prose=""
        innerHTML={renderSafeMarkdown(props.markdown ?? "", { locale: locale(), allowImages: false, linkProtocols: proseLinks })}
      />
    </Show>
  );
};

export type InlineProps = { children: JSX.Element };

/**
 * One line of things with the one fixed gap of 8 px. In a column it carries the text edge itself. In a column narrower
 * than 480 px it wraps onto more lines instead of cutting a thing; in a bar it flows together with the bar's end.
 */
export const Inline = (props: InlineProps) => (
  <div class="k2-inline" data-k2-part="Inline">
    {props.children}
  </div>
);

// ── Facts ────────────────────────────────────────────────────────────────────────────────────────────────────────

export type Fact = {
  /** The quiet label before the value. */
  label: string;
  /** The value: words, a `Chip` or a link. */
  value: JSX.Element;
  /** A quiet word under the value, such as "Standard". */
  hint?: string;
  /** Offers a copy button at the value; the text that is copied. */
  copy?: string;
  /**
   * A value to be read sign by sign, such as a token, a key or an ID: monospace, it breaks at any sign instead of
   * mid-word, and one click selects all of it for copying.
   */
  mono?: boolean;
};

export type FactsProps = {
  /** The labels with their values, in their order. */
  items: readonly Fact[];
  /** All facts on one line, labels quiet before their values. */
  inline?: boolean;
  /** At the end of the inline line, such as "Print". */
  end?: JSX.Element;
  /**
   * The values are on their way: a quiet bar lies on each, while labels, hints and copy buttons (not yet usable) stay.
   * A value that is there (a refresh) keeps its exact room unseen under the bar, its lines, chips and wrapping; a value
   * not there yet (`""`, `undefined`) is a bar of one line. So nothing moves when they come. Assistive technology
   * hears "Wird geladen…" at each value. Give the labels the values will have, and `copy` (an empty string is
   * enough) where a value will have it.
   */
  loading?: boolean;
};

/**
 * Values with their labels: label 12 quiet, value 13, 32 px a row, copy at the value. The label column is as wide as
 * the longest label, at least 80 px and at most 160 px.
 */
export const Facts = (props: FactsProps) => {
  // A list of pairs (dt, dd); a copy button stands inside its value, the end of an inline line beside the list.
  const list = (part?: string) => (
    <dl class="k2-facts" data-k2-part={part} data-inline={props.inline ? "" : undefined} aria-busy={props.loading ? "true" : undefined}>
      <For each={props.items}>
        {(item) => (
          <div class="k2-fact-pair">
            <dt>{item.label}</dt>
            <dd>
              <span class="k2-fact-value" data-mono={item.mono ? "" : undefined}>
                <Show when={!props.loading} fallback={<PlaceholderValue>{item.value}</PlaceholderValue>}>
                  {item.value}
                </Show>
                <Show when={item.hint}>
                  <small>{item.hint}</small>
                </Show>
              </span>
              {/* while the value is on its way its copy button stands, not yet usable, so nothing moves when it comes */}
              <Show when={!props.inline && (props.loading ? item.copy !== undefined : item.copy)}>
                <CopyButton label={item.label} value={item.copy ?? ""} disabled={props.loading} />
              </Show>
            </dd>
          </div>
        )}
      </For>
    </dl>
  );
  const end = resolveChildren(() => props.end);
  return (
    <Show when={props.inline && end() !== undefined} fallback={list("Facts")}>
      <div class="k2-facts-line" data-k2-part="Facts">
        {list()}
        <div class="k2-facts-end">{end()}</div>
      </div>
    </Show>
  );
};

// ── Row and List ─────────────────────────────────────────────────────────────────────────────────────────────────

const ListContext = createContext(false);

export type ListProps = {
  /** The entries, each a `Row`. */
  children: JSX.Element;
  /** A name for the list, for assistive technology. */
  label?: string;
};

/**
 * Rows that come or go above the place someone works on (a new mail on top) leave that place where it was: the
 * focused row, else the first visible one, keeps its distance to the top of the column. When that row goes itself,
 * the row after it takes its place, else the row before it keeps its own. Browsers with CSS scroll anchoring already
 * hold the place, so nothing moves twice there; Safari ships none. At the very top nothing is held, so a new row shows
 * up there. (As v1's `MailConversationList`.)
 */
const keepPlace = (list: HTMLElement) => {
  const scroller = list.closest<HTMLElement>(".k2-scroll");
  if (!scroller || typeof MutationObserver === "undefined") return;
  type Place = { row: HTMLElement; top: number };
  let held: { place: Place; next?: Place; previous?: Place } | null = null;
  const isRow = (node: Node | null): node is HTMLElement => node instanceof HTMLElement && node.matches(".k2-row");
  const hold = () => {
    const view = scroller.getBoundingClientRect();
    const placeOf = (row: HTMLElement): Place => ({ row, top: row.getBoundingClientRect().top - view.top });
    const visible = (row: HTMLElement) => {
      const box = row.getBoundingClientRect();
      return box.bottom > view.top && box.top < view.bottom;
    };
    const focused = document.activeElement?.closest<HTMLElement>(".k2-row");
    const row =
      scroller.scrollTop <= 0
        ? undefined
        : focused && focused.parentElement === list && visible(focused)
          ? focused
          : Array.from(list.children).find((each) => isRow(each) && each.getBoundingClientRect().top >= view.top);
    if (!row || !isRow(row)) {
      held = null;
      return;
    }
    const next = row.nextElementSibling;
    const previous = row.previousElementSibling;
    held = {
      place: placeOf(row),
      // the row after it would take its place, the row before it keeps its own
      next: isRow(next) ? { row: next, top: placeOf(row).top } : undefined,
      previous: isRow(previous) ? placeOf(previous) : undefined,
    };
  };
  const changed = (records: MutationRecord[]) => {
    if (!records.some((record) => [...record.addedNodes, ...record.removedNodes].some(isRow))) return;
    const place = [held?.place, held?.next, held?.previous].find((each) => each?.row.isConnected);
    if (place) {
      const moved = place.row.getBoundingClientRect().top - scroller.getBoundingClientRect().top - place.top;
      if (Math.abs(moved) >= 1) scroller.scrollTop += moved;
    }
    hold();
  };
  const rows = new MutationObserver(changed);
  rows.observe(list, { childList: true });
  scroller.addEventListener("scroll", hold, { passive: true });
  scroller.addEventListener("focusin", hold);
  hold();
  onCleanup(() => {
    rows.disconnect();
    scroller.removeEventListener("scroll", hold);
    scroller.removeEventListener("focusin", hold);
  });
};

/** Rows one under the other. (Selection, keyboard and drag come with the behaviour layer.) */
export const List = (props: ListProps) => {
  let list: HTMLDivElement | undefined;
  onMount(() => {
    if (list) keepPlace(list);
  });
  return (
    <div ref={list} class="k2-list" data-k2-part="List" role="list" aria-label={props.label}>
      <ListContext.Provider value={true}>{props.children}</ListContext.Provider>
    </div>
  );
};

export type RowLines = readonly [JSX.Element] | readonly [JSX.Element, JSX.Element] | readonly [JSX.Element, JSX.Element, JSX.Element];

export type RowProps = {
  /**
   * One to three lines; the role follows the position: one line 40 px, two lines 52 px (the second quiet, 12 px),
   * three lines 72 px (the second a row, the third quiet). A row of three lines cuts each line with "…".
   */
  lines: RowLines;
  /** A quiet note after the title, such as a count or an address. */
  meta?: JSX.Element;
  /** The lead: a quiet symbol for what the row is … */
  icon?: string;
  /**
   * … the mark of the thing the row stands for (a base, a file with its thumbnail, a table): its symbol on a tint of
   * its colour, or its picture; 24 px in a row of one line, 32 px in a row of two or three …
   */
  mark?: MarkProps;
  /** … or a person. */
  avatar?: Person;
  /** Unread: a dot leads and the first two lines turn 600. */
  unread?: boolean;
  /** The title in 600. */
  strong?: boolean;
  /** The open one (its detail is shown), in the tint of the app; like `current` of `Nav`, `Tabs` and `Table`. */
  current?: boolean;
  /**
   * The row stands in a selection, such as "10 ausgewählt" (pair it with `StatusRow selection`): a box in the lead,
   * named by the title, and the blue tint while `selected`, as `Table select` draws it. The box takes the place of the
   * lead's symbol, person or dot; a `mark` stays beside it, so a file keeps its thumbnail. Open and selected combine: a
   * selected row stays blue, and stays the open one.
   */
  select?: { selected: boolean; onChange: (selected: boolean) => void };
  /** "You are next", in the blue tint. */
  yours?: boolean;
  /** Top right, quiet: a time or a date. */
  time?: JSX.Element;
  /** Bottom right on the third line: chips, icons, people. */
  marks?: JSX.Element;
  /**
   * States that belong to the entry and must be read whole, such as the checks of a domain: `Chip`s with colour,
   * symbol and word under the row's lines, on the text edge of its title. They wrap to further lines instead of being
   * cut, on the phone too; the row grows only when they are there (40, 52 and 72 px stay as they are without them).
   */
  states?: JSX.Element;
  /** The one deed of this entry, a framed button at the end; on the phone it moves under the text. */
  action?: Action;
  /** At the end: a few icon buttons, such as "Reply" and "More". */
  end?: JSX.Element;
  /** The row opens this link … */
  href?: string;
  /** … in place on a plain click, while the link still opens in a new tab (see `OnNavigate`) … */
  onNavigate?: OnNavigate;
  /** … or calls this. */
  onOpen?: () => void;
};

/**
 * What opens an entry: the title becomes a link or a button, stretched over the whole entry. It is never the entry
 * itself, so buttons and links inside the entry stay buttons and links of their own (no control inside a control).
 */
export const RowOpen = (props: {
  href?: string;
  onNavigate?: OnNavigate;
  onOpen?: () => void;
  /** The row around it takes the focus (a table's tree): the link leaves the tab order to the row. */
  rowFocus?: boolean;
  children: JSX.Element;
}) => (
  <Show when={props.href !== undefined || props.onOpen} fallback={props.children}>
    <Show
      when={props.href !== undefined}
      fallback={
        <button type="button" class="k2-row-open" tabindex={props.rowFocus ? -1 : undefined} onClick={() => props.onOpen?.()}>
          {props.children}
        </button>
      }
    >
      <Link
        class="k2-row-open"
        href={props.href ?? ""}
        tabindex={props.rowFocus ? -1 : undefined}
        onNavigate={props.onNavigate}
        onClick={() => props.onOpen?.()}
      >
        {props.children}
      </Link>
    </Show>
  </Show>
);

/** The signs of a deed at the end of a row beyond which it stands under the text in a column under 640 px. */
const longDeed = 24;

/** One entry: from column edge to column edge, square, also when it opens something. */
export const Row = (props: RowProps) => {
  const inList = useContext(ListContext);
  // Parts passed as JSX are made once and read from here: reading a prop again would make its JSX again.
  const text = createMemo(() => props.lines);
  const lines = () => text().length;
  const meta = resolveChildren(() => props.meta);
  const time = resolveChildren(() => props.time);
  const end = resolveChildren(() => props.end);
  const marks = resolveChildren(() => props.marks);
  const states = resolveChildren(() => props.states);
  const title = createUniqueId();
  return (
    <div
      class="k2-row"
      data-k2-part="Row"
      role={inList ? "listitem" : undefined}
      data-open={props.href !== undefined || props.onOpen ? "" : undefined}
      data-lines={String(lines())}
      data-unread={props.unread ? "" : undefined}
      data-strong={props.strong ? "" : undefined}
      data-current={props.current ? "" : undefined}
      aria-current={props.current ? "true" : undefined}
      data-selected={props.select?.selected ? "" : undefined}
      data-yours={props.yours ? "" : undefined}
      // in a selection the box takes the person's place, so the row's text starts where the other rows' text does
      data-avatar={props.avatar && !props.select ? "" : undefined}
      data-mark={props.mark && !props.avatar ? "" : undefined}
      data-time={time() !== undefined ? "" : undefined}
      // a long deed (more than 24 signs, some 170 px) stands under the text in a narrow column, never beside a squeezed one
      data-action={props.action ? ([...props.action.label].length > longDeed ? "long" : "") : undefined}
      data-states={states() !== undefined ? "" : undefined}
    >
      {/* What opens the row lies over all of it and is named by the title; it holds no part of the row, so a link in
          the title stays a link of its own (no link inside a link). */}
      <Show when={props.href !== undefined || props.onOpen}>
        <Show
          when={props.href !== undefined}
          fallback={<button type="button" class="k2-row-open" aria-labelledby={title} onClick={() => props.onOpen?.()} />}
        >
          {/* The row's title names the link through aria-labelledby; holding the title would put a link of the title
              inside this one. */}
          <Link
            class="k2-row-open"
            href={props.href ?? ""}
            aria-labelledby={title}
            onNavigate={props.onNavigate}
            onClick={() => props.onOpen?.()}
          />
        </Show>
      </Show>
      {/* in a selection with a mark the lead holds both, the box before the mark (a mark the stylesheet cannot ask for
          through an island's wrapper) */}
      <span class="k2-row-lead" data-pair={props.select && props.mark ? "" : undefined}>
        <Show
          when={props.select}
          fallback={
            <Show
              when={props.avatar}
              fallback={
                <Show
                  when={props.mark}
                  fallback={
                    <Show
                      when={props.icon}
                      fallback={
                        <Show when={props.unread}>
                          <Dot status="ok" />
                        </Show>
                      }
                    >
                      {(name) => <Icon name={name()} />}
                    </Show>
                  }
                >
                  {(mark) => <Mark {...mark()} />}
                </Show>
              }
            >
              {(person) => <Avatar {...person()} />}
            </Show>
          }
        >
          {(select) => (
            <>
              <MarkCheck labelledBy={title} checked={select().selected} onChange={(on) => select().onChange(on)} />
              {/* a thing's mark stays beside the box (a file keeps its thumbnail); a symbol, person or dot gives way */}
              <Show when={props.mark}>{(mark) => <Mark {...mark()} />}</Show>
            </>
          )}
        </Show>
      </span>
      <span class="k2-row-l1">
        <span class="k2-row-title" id={title}>
          {text()[0]}
        </span>
        <Show when={meta() !== undefined}>
          <span class="k2-row-meta">{meta()}</span>
        </Show>
      </span>
      <Show when={lines() > 1}>
        <span class="k2-row-l2">{text()[1]}</span>
      </Show>
      <Show when={lines() > 2}>
        <span class="k2-row-l3">{text()[2]}</span>
      </Show>
      <Show when={time() !== undefined}>
        <span class="k2-row-time">{time()}</span>
      </Show>
      <Show when={end() !== undefined || props.action}>
        <span class="k2-row-end">
          <Show when={props.action}>{(action) => <ActionButton action={action()} />}</Show>
          {end()}
        </span>
      </Show>
      <Show when={marks() !== undefined}>
        <span class="k2-row-marks">{marks()}</span>
      </Show>
      <Show when={states() !== undefined}>
        <span class="k2-row-states">{states()}</span>
      </Show>
    </div>
  );
};

// ── Table ────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The lines of a cell: the line itself and a quiet second line under it; with `avatar` a person before them (a user,
 * a group). The lines are cut with "…", never in the middle of a sign.
 */
export type CellLines = { lines: readonly [JSX.Element, JSX.Element] | readonly [JSX.Element]; avatar?: Person };

/**
 * What a cell shows: one line, two lines named as such (`{ lines: [first, second] }`), or a person with one or two
 * lines (`{ avatar, lines: [name] }`).
 */
export type CellValue = JSX.Element | CellLines;

export type Column<T> = {
  /** The head of the column. */
  title: string;
  /** What a cell shows: one line, or two lines named as such. */
  cell: (row: T) => CellValue;
  /** Numbers and amounts stand at the end; a column at the end is `numeric`. */
  align?: "start" | "end";
  /** The cell leads with the thing's mark: a file's thumbnail or type, a base's symbol (24 px, rule: each thing its mark). */
  mark?: (row: T) => MarkProps;
  /** The cell leads with a person, such as the owner; the name in the cell names the avatar. */
  avatar?: (row: T) => Person;
  /**
   * Numbers, amounts, times and durations: a cut one reads as another value ("12.345.678,…"), so they are never cut.
   * Tabular figures; the column is at least as wide as its longest text value, beyond its `width`. Set by
   * `align: "end"`; give it to a time or date column at the start.
   */
  numeric?: boolean;
  /**
   * The width of the column, its minimum and default in px: a column that can be dragged wider or narrower (a grip in
   * its head); in a small table it is its default wide where the row has room and shares the room left with the other
   * columns that can give way; where the row has less, it gives way down to its minimum. `{ fixed }` is that width
   * without a grip, such as a narrow column of row actions; it neither gives way nor grows. Columns without a width
   * share the rest of the row by how much their text asks for (at least 96 px each). Cut text never widens a column.
   */
  width?: Width;
  /** A text column that may wrap to at most three lines; the row grows, every other cell stays on its first line. */
  wrap?: boolean;
  /**
   * Drops away where the table has no room for it (rule 7: columns drop, they do not shrink): in a table with column
   * widths one by one from the last such column as its place gets narrower than the columns need, and all of them in a
   * column narrower than 480 px.
   */
  drop?: boolean;
  /**
   * The rows can be sorted by this column: its head is pressed to sort. Give the address of the page sorted so
   * (`href`, which reload, back and links keep; with `onNavigate` it opens in place) or a deed (`onSort`). The app
   * decides the order a press leads to, such as the other direction when the column is the sorted one; the table's
   * `sort` says which column that is now.
   */
  sort?: SortTarget;
};

/** Where pressing a column head leads: the address of the rows sorted by it, or a deed that sorts them in place. */
export type SortTarget =
  | { href: string; onNavigate?: OnNavigate; onSort?: undefined }
  | { href?: undefined; onNavigate?: undefined; onSort: () => void };

/** Where an entry leads: a page (a real link, also before the page is live) or a deed in place. */
export type OpenTarget =
  | { href: string; onNavigate?: OnNavigate; onOpen?: () => void }
  | { href?: undefined; onNavigate?: undefined; onOpen: () => void };

type TableBase<T> = {
  /** The columns, in order; see `Column`. */
  columns: readonly Column<T>[];
  /** The rows. */
  rows: readonly T[];
  /** A name for the table, for assistive technology. */
  label?: string;
  /** The first column (and the box column) stays while the table scrolls sideways; an edge shows behind it. */
  sticky?: boolean;
  /** The column the rows are sorted by now: an arrow in its head and darker words (a column's `sort` makes it pressable). */
  sort?: { column: number; direction: "ascending" | "descending" };
  /** What a row opens, on the desktop and on the phone: its first cell is the link or button. */
  open?: (row: T) => OpenTarget;
  /**
   * On the phone each row becomes a row of two lines instead (rule 7): `time` stands top right, `marks` at the end of
   * the second line, such as the state of the entry as a chip.
   */
  phone?: (row: T) => {
    lines: readonly [JSX.Element, JSX.Element];
    avatar?: Person;
    /** The thing's mark (a file's thumbnail, a base's symbol), as `Row mark`. */
    mark?: MarkProps;
    time?: JSX.Element;
    marks?: JSX.Element;
    /** The row's deeds at its end, such as its "…" menu, as `Row end`: what a column of deeds offers on the desktop. */
    end?: JSX.Element;
  };
  /**
   * While the rows load: the head stays and square placeholders hold the place of the rows, so nothing moves when they
   * come; `rows` (3 when not set) and `lines` (1 or 2) say how many and how high.
   */
  loading?: boolean | { rows?: number; lines?: 1 | 2 };
  /** No rows and nothing loading: the empty state stands in place of the table, such as "Keine Aufträge mit diesem Filter." */
  empty?: EmptyProps;
};

/** A table whose rows are told apart: selection, the open row and groups need the stable key of a row. */
type KeyedTable<T> = {
  /** The stable key of a row. */
  rowKey: (row: T) => string;
  /**
   * A large table (Grids): a box column to select rows. The status row shows what can be done with them
   * (`StatusRow selection`).
   */
  select?: {
    selected: readonly string[];
    onChange: (keys: readonly string[]) => void;
    /** The name of the box of all rows and of one row, such as "Alle Aufträge" and the row's title. */
    all: string;
    row: (row: T) => string;
  };
  /** The key of the open row, in the tint of the app. */
  current?: string;
  /**
   * Rows of a group follow one another under its head: text in 600 with its count, no band and no line under it; the
   * line under the row before it separates the groups (no frame: it would cut the columns).
   */
  group?: (row: T) => TableGroup;
  /** Rows in levels, such as folders and their files (not with `group`). */
  tree?: TableTree<T>;
};

type PlainTable = { rowKey?: undefined; select?: undefined; current?: undefined; group?: undefined; tree?: undefined };

/**
 * Rows in levels: `rows` are the top level, a row's children stand under it, one level further in, while it is open.
 * The arrow in the first cell, or Right and Left on the row, opens and closes it without opening the row; Up, Down,
 * Home and End move between rows, Enter opens the row (the table is one stop for Tab). On the phone only the top
 * level shows; its rows open as pages.
 */
export type TableTree<T> = {
  /** The children loaded so far; `undefined` while they are not loaded. */
  children: (row: T) => readonly T[] | undefined;
  /** The row has children, also before they load. */
  branch: (row: T) => boolean;
  /** The keys of the open rows. Leave out and the table keeps them itself, starting with the way to `current`. */
  expanded?: readonly string[];
  onExpandedChange?: (expanded: string[]) => void;
  /**
   * Loads the children of a branch without children the first time it opens; the app then gives them through
   * `children`. While it runs the arrow turns; a rejection shows a red mark, and opening the row again tries again.
   */
  load?: (row: T, context: { signal: AbortSignal }) => Promise<unknown>;
  /** More children exist than are loaded (`null`: more top rows): `true` or how many; a last row "Weitere laden" follows. */
  more?: (row: T | null) => true | number | undefined;
  /** Loads the next page of the children of `row` (`null`: of the top level); the app adds them. */
  loadMore?: (row: T | null) => Promise<unknown>;
};

export type TableProps<T> = TableBase<T> & (KeyedTable<T> | PlainTable);

/** The arrow of the sorted column, after its words: up for ascending, down for descending. */
const SortArrow = (props: { sorted?: "ascending" | "descending" }) => (
  <Show when={props.sorted}>{(sorted) => <Icon name={sorted() === "descending" ? "arrow-down" : "arrow-up"} />}</Show>
);

/**
 * The grip at the start of a column head: it moves the width of the column before it (`useGrip`). A column is at
 * most as wide as the table's visible width; the table scrolls sideways when its columns need more.
 */
const ColumnGrip = (props: {
  label: string;
  width: { min: number; default: number };
  /** The width a drag gave the column; nothing while it stands by the table's layout. */
  size: number | undefined;
  onChange: (px: number | undefined) => void;
}) => {
  const grip = useGrip({
    label: () => props.label,
    value: () => props.size ?? props.width.default,
    onChange: (px) => props.onChange(px),
    // a column never dragged moves from where it stands, also wider than its default (delta review r2)
    start: (now) => props.size ?? now,
    // Escape puts back what was before the drag, also "never dragged"
    undo: () => {
      const size = props.size;
      return () => props.onChange(size);
    },
    min: () => props.width.min,
    reset: () => props.width.default,
    direction: () => 1,
    measure: (element) => {
      const head = element.parentElement?.previousElementSibling;
      const scroller = element.closest(".k2-table-scroll");
      const now = head?.getBoundingClientRect().width;
      if (!now || !scroller) return undefined;
      return { now, max: scroller.clientWidth };
    },
    // the table's visible width and every column head
    observe: (element) => {
      const scroller = element.closest(".k2-table-scroll");
      const heads = element.parentElement?.parentElement?.children ?? [];
      return scroller ? [scroller, ...heads] : [...heads];
    },
  });
  return <span class="k2-cgrip" {...grip} />;
};

/** Two lines only when they are named so: an array of two parts (a fragment) stays one line. */
const isPair = (value: CellValue): value is CellLines =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  !(typeof Node !== "undefined" && value instanceof Node) &&
  "lines" in value;

/** The range of a column that can be dragged; a `fixed` width or none has no grip. */
const resizable = <T,>(column: Column<T>) => (column.width && !("fixed" in column.width) ? column.width : undefined);

/** A column of numbers, amounts or times: never cut. */
const isNumeric = <T,>(column: Column<T>) => column.numeric ?? column.align === "end";

/**
 * The signs of a text value, of a cell's first line (the value; the quiet line under it is a note that may wrap); 0
 * for what is not text, which is not measured.
 */
const signsOf = (value: CellValue): number => {
  if (typeof value === "string" || typeof value === "number") return [...String(value)].length;
  if (isPair(value)) return signsOf(value.lines[0]);
  return 0;
};

/**
 * What a column without a width counts with (its default and its minimum), and the room a figure takes in those sums:
 * 10 px, above what any font gives a figure of the row's 13 px (Plex 7.6, a fallback font 8.3), so a column reckoned
 * for a number never falls short of what the number takes.
 */
const flexibleColumn = 160;
const flexibleMin = 96;
const figureWidth = 10;

/**
 * A group of rows: its key, its head (such as a state chip), quiet figures after it, and its count, quiet after the
 * head on the desktop and on the phone.
 * The head is made where it stands (the table and the phone list each make their own), so it is a function.
 */
export type TableGroup = { key: string; head: () => JSX.Element; meta?: string; count?: string };

/** Where a row stands in the tree: its level, its place among its siblings and whether it is an open branch. */
type TreePlace = { level: number; parent: string | null; position: number; size: number; branch: boolean; expanded: boolean };

type TableItem<T> = { group: TableGroup } | { row: T; index: number; tree?: TreePlace } | { more: MoreRow };

/** The "Weitere laden" row of a level: where it stands, how many are still to come, the size of its level. */
type MoreRow = { parent: string | null; level: number; count: true | number; position: number; size: number };

// The key of the "Weitere laden" row of a level; no row key starts with a word joiner.
const MORE_ROW = "\u2060more:";

/**
 * Many like things in columns: head 36, a line under every row, none between columns. Long text stays on one line
 * with "…" and a fixed row height (variant a, decided 22.11.); `wrap` lets one text column take three lines. With
 * `select` or `sticky` it is the large table of Grids: one scroller for head and rows, a sticky head and first column,
 * rows and cells under the pointer, groups as tinted rows.
 */
export const Table = <T,>(props: TableProps<T>) => {
  const t = useTreeMessages();
  const said = useBehaviorMessages();
  const grid = () => props.select !== undefined || props.sticky === true;
  const sized = () => grid() || props.columns.some((column) => column.width);
  const key = (row: T, index: number) => props.rowKey?.(row) ?? String(index);

  // ── Rows in levels (`tree`) ──
  // the keys from the top down to the parent of the open row, so the way to it starts open
  const wayTo = (target: string | undefined): string[] => {
    const tree = props.tree;
    if (!tree || target === undefined) return [];
    const walk = (list: readonly T[]): string[] | undefined => {
      for (const [index, row] of list.entries()) {
        const rowKey = key(row, index);
        if (rowKey === target) return [];
        const below = walk(tree.children(row) ?? []);
        if (below) return [rowKey, ...below];
      }
      return undefined;
    };
    return walk(props.rows) ?? [];
  };
  const [ownExpanded, setOwnExpanded] = createSignal<readonly string[]>(untrack(() => props.tree?.expanded ?? wayTo(props.current)));
  const expanded = () => props.tree?.expanded ?? ownExpanded();
  const setExpanded = (next: string[]) => {
    // a row whose state changes is drawn anew; the focus it had stays on it
    const kept = body?.contains(document.activeElement) ? focused() : undefined;
    if (props.tree?.expanded === undefined) setOwnExpanded(next);
    props.tree?.onExpandedChange?.(next);
    if (kept !== undefined)
      requestAnimationFrame(() => {
        if (focusLost()) focusRow(kept);
      });
  };
  const [busy, setBusy] = createSignal<readonly string[]>([]);
  const [failed, setFailed] = createSignal<readonly string[]>([]);
  const loads = new Map<string, AbortController>();
  onCleanup(() => loads.forEach((load) => load.abort()));

  // What shows, in reading order: the rows, the children of open rows under them, and a "Weitere laden" row after a
  // level that has more. Without `tree`, the rows themselves.
  const flat = createMemo((): ({ row: T; tree?: TreePlace } | { more: MoreRow })[] => {
    const tree = props.tree;
    if (!tree) return props.rows.map((row) => ({ row }));
    const open = new Set(expanded());
    const out: ({ row: T; tree: TreePlace } | { more: MoreRow })[] = [];
    const walk = (list: readonly T[], parent: T | null, parentKey: string | null, level: number) => {
      const more = tree.loadMore ? tree.more?.(parent) : undefined;
      // a level that pages says its whole size: the loaded rows and those still to come, -1 while nobody knows it
      const size = more === undefined ? list.length : more === true ? -1 : list.length + more;
      list.forEach((row, index) => {
        const rowKey = key(row, index);
        const branch = tree.branch(row);
        const isOpen = branch && open.has(rowKey) && tree.children(row) !== undefined;
        out.push({ row, tree: { level, parent: parentKey, position: index + 1, size, branch, expanded: isOpen } });
        if (isOpen) walk(tree.children(row) ?? [], row, rowKey, level + 1);
      });
      if (more !== undefined) out.push({ more: { parent: parentKey, level, count: more, position: list.length + 1, size } });
    };
    walk(props.rows, null, null, 1);
    return out;
  });
  const shownRows = createMemo(() => flat().flatMap((entry) => ("row" in entry ? [entry] : [])));
  // Every cell is made once: what `cell` returns is placed, never rendered a second time. In a tree, the cells of a row
  // stay while rows open and close around it.
  let made = new Map<T, CellValue[]>();
  let madeFor: readonly Column<T>[] | undefined;
  const values = createMemo(() => {
    const columns = props.columns;
    if (!props.tree) return shownRows().map((entry) => columns.map((column) => column.cell(entry.row)));
    const before = madeFor === columns ? made : new Map<T, CellValue[]>();
    const next = new Map<T, CellValue[]>();
    const list = shownRows().map((entry) => {
      const cells = before.get(entry.row) ?? columns.map((column) => column.cell(entry.row));
      next.set(entry.row, cells);
      return cells;
    });
    made = next;
    madeFor = columns;
    return list;
  });
  /** The made cells of a row: by its place without a tree, by the row itself in a tree (its place moves). */
  const cellsOf = (item: { row: T; index: number }) => {
    const list = values();
    return (props.tree ? made.get(item.row) : undefined) ?? list[item.index]!;
  };
  // the shape of the placeholders while the rows load
  const loading = () => {
    const shape = props.loading;
    return shape === true ? { rows: 3, lines: 1 as const } : shape ? { rows: shape.rows ?? 3, lines: shape.lines ?? 1 } : undefined;
  };
  const empty = () => (loading() || props.rows.length > 0 ? undefined : props.empty);
  const lines = () =>
    loading()?.lines === 2 || values().some((row) => row.some((value) => isPair(value) && value.lines.length === 2)) ? "2" : "1";
  // A numeric column is at least as wide as its longest text value, and its head, in signs (`ch`, the width of a
  // figure). A column whose values are no text (parts made by the app) is not measured and keeps its width.
  const signs = createMemo(() =>
    props.columns.map((column, index) => {
      if (!isNumeric(column)) return 0;
      const longest = values().reduce((most, row) => Math.max(most, signsOf(row[index]!)), 0);
      return longest === 0 ? 0 : Math.max(longest, signsOf(column.title));
    }),
  );
  // The room each column's content asks for, in px: a text its signs at about 7 px and the padding of its cell, a part
  // the app made (a chip, a link, a button) as much as a column without a width; at least its head. The columns
  // without a width share the rest of the row in this measure, so the one with more to say gets more room.
  const rooms = createMemo(() =>
    props.columns.map((column, index) => {
      const text = (signs: number) => Math.max(signs, 1) * 7 + 32;
      const ask = (value: CellValue) =>
        typeof value === "string" || typeof value === "number" || isPair(value)
          ? text(signsOf(value))
          : value === undefined || value === null || typeof value === "boolean"
            ? 0
            : flexibleColumn;
      return values().reduce((most, row) => Math.max(most, ask(row[index]!)), text(signsOf(column.title)));
    }),
  );
  // What each column needs, in px: at least `lo` (its minimum; a numeric one its longest value) and at most `hi` (its
  // default). A column without a width counts with 96 and 160 px.
  // A `fixed` width is its minimum and its default at once; so is a width a person dragged with the grip (`sizes`).
  // The widths the grips gave columns, by index; a column keeps its own width until then.
  const [sizes, setSizes] = createSignal<Readonly<Record<number, number>>>({});
  const held = (index: number) =>
    sizes()[index] !== undefined || (props.columns[index]?.width ? "fixed" in props.columns[index]!.width! : false);
  const need = createMemo(() =>
    props.columns.map((column, index) => {
      const fit = (signs()[index] ?? 0) > 0 ? (signs()[index] ?? 0) * figureWidth + 32 : 0;
      const dragged = sizes()[index];
      // a dragged column holds the width it was given; the others give way and drop as before (delta review r2: holding
      // them all at their default made them jump and a drop column leave on the first drag)
      const span = dragged !== undefined ? { min: dragged, default: dragged } : column.width ? widthRange(column.width) : undefined;
      const lo = Math.max(span?.min ?? flexibleMin, fit);
      return { lo, hi: Math.max(span?.default ?? flexibleColumn, lo) };
    }),
  );
  const box = props.select ? 44 : 0;
  // In a small table with widths every column moves between its minimum and its default with the width of the table's
  // place (`100cqw`, the table's container), so together they fill it: at the sum of the defaults each has its default,
  // at the sum of the minimums each its minimum. The stylesheet decides, on the server's page too.
  // The sums are over the columns shown: after `drop` columns left, the others share the room among themselves.
  // Above the sum of the defaults the room left is shared among the columns with a width that can give way (minimum
  // below default), in the measure they give way: no column takes all of it, and an action column at the end leaves
  // no air on the right. Columns without a width take the rest themselves (below).
  const round = (value: number) => Math.round(value * 10000) / 10000;
  // A column's share of a room, given every column's part (0: not sharing), rounded. The last sharing column takes
  // what the others leave, so the shares never add up to more than the room (delta review r2: 0.1 px a column made
  // the table scroll by 1 px).
  const share = (index: number, parts: readonly number[]) => {
    const sum = parts.reduce((all, part) => all + part, 0);
    if (sum <= 0 || parts[index]! <= 0) return 0;
    const last = parts.findLastIndex((part) => part > 0);
    if (index !== last) return round(parts[index]! / sum);
    return round(1 - parts.reduce((taken, part, at) => (at === last || part <= 0 ? taken : taken + round(part / sum)), 0));
  };
  const shrink = (index: number, gone: ReadonlySet<number> = new Set()) => {
    const { lo, hi } = need()[index]!;
    const shown = (at: number) => !gone.has(at);
    const isFree = (at: number) => shown(at) && props.columns[at]!.width === undefined;
    // a column without a width only fills what is left, so it counts with its minimum: the others reach their default
    // as soon as the row holds them and that minimum
    const reach = (at: number) => (isFree(at) ? need()[at]!.lo : need()[at]!.hi);
    const least = need().reduce((sum, each, at) => (shown(at) ? sum + each.lo : sum), box);
    const most = need().reduce((sum, _, at) => (shown(at) ? sum + reach(at) : sum), box);
    const below =
      hi === lo || most <= least
        ? `${lo}px`
        : `clamp(${lo}px, calc(${lo}px + (100cqw - ${least}px) * ${share(
            index,
            need().map((each, at) => (shown(at) && !isFree(at) ? each.hi - each.lo : 0)),
          )}), ${hi}px)`;
    // What grows: the columns without a width (below); without them, the columns that can give way, in the measure they
    // do; when every column is fixed, the last one, so there is always one that takes the rest of the row.
    const free = need().filter((_, at) => isFree(at)).length;
    // The columns without a width fill the whole rest of the row together. Each keeps its minimum; what the row has
    // beyond the others and those minimums (100cqw − most) goes to them in the measure their content asks for more
    // than its minimum. So they sum to the row exactly from `least` on, and a short column raised to its minimum
    // takes nothing from the long one's share (delta review of #4209: no sideways scroll at medium widths).
    if (free > 0 && isFree(index)) {
      const extras = need().map((each, at) => (isFree(at) ? Math.max(rooms()[at]! - each.lo, 0) : 0));
      const parts = extras.some((extra) => extra > 0) ? extras : need().map((_, at) => (isFree(at) ? 1 : 0));
      return `max(${lo}px, calc(${lo}px + (100cqw - ${most}px) * ${share(index, parts)}))`;
    }
    if (free > 0) return below;
    const spans = need().map((each, at) => (shown(at) && props.columns[at]!.width && !held(at) ? each.hi - each.lo : 0));
    const lastShown = props.columns.findLastIndex((_, at) => shown(at));
    const weight = spans.some((span) => span > 0) ? share(index, spans) : index === lastShown ? 1 : 0;
    if (weight === 0) return below;
    return `max(${below}, calc(${hi}px + (100cqw - ${most}px) * ${weight}))`;
  };
  const colWidth = (column: Column<T>, index: number, gone?: ReadonlySet<number>): string | undefined => {
    const count = signs()[index] ?? 0;
    const fit = count > 0 ? `calc(${count}ch + 12px + var(--k2-edge))` : undefined;
    // a small table with widths sizes every column, also one without a width of its own; a large table keeps defaults
    const fixed = sizes()[index] ?? (column.width ? widthRange(column.width).default : undefined);
    const base = grid() ? (fixed !== undefined ? `${fixed}px` : undefined) : sized() ? shrink(index, gone) : undefined;
    return base && fit ? `max(${base}, ${fit})` : (base ?? fit);
  };
  const measured = () => signs().some((count) => count > 0);
  const id = createUniqueId();
  // A table of fixed columns is never narrower than the columns that stay need at their minimum: in a place narrower
  // than that it scrolls sideways (with a fade at the edge it continues past), so no column squeezes a number.
  const least = () =>
    sized() && !grid() ? need().reduce((sum, width, index) => (props.columns[index]!.drop ? sum : sum + width.lo), box) : undefined;
  // Rule 7 by the room of the table: the `drop` columns go one by one, from the last, as the table's place gets
  // narrower than the columns it shows need at their minimum. The room is known from the widths (and the measured
  // numbers), so the stylesheet decides on the server's page too; it is one container query per table.
  const steps = createMemo(() => {
    if (!sized()) return [] as { column: number; below: number }[];
    // a large table keeps its columns at their default (it never shrinks them), so its steps reckon with the defaults
    const widths = need().map((width) => (grid() ? width.hi : width.lo));
    let room = widths.reduce((sum, width) => sum + width, box);
    const out: { column: number; below: number }[] = [];
    for (let index = props.columns.length - 1; index >= 0; index--) {
      if (!props.columns[index]!.drop) continue;
      out.push({ column: index, below: room });
      room -= widths[index]!;
    }
    return out;
  });
  const step = (index: number) => {
    const at = steps().findIndex((entry) => entry.column === index);
    return at < 0 ? undefined : String(at + 1);
  };
  // A large table lays itself out by its content, so a column leaves whole; a table of fixed columns keeps the column
  // in its grid of columns (a group row spans them all) at no width, so the others keep theirs.
  const hide = (selector: string) =>
    grid() ? `${selector} { display: none; }` : `${selector} { width: 0; padding: 0; visibility: hidden; overflow: hidden; }`;
  // Each step hides its column and, in a table of fixed columns, gives the columns still shown their widths anew over
  // themselves, so they fill the room the column left instead of the last one taking all of it.
  const dropRule = () =>
    steps()
      .map((entry, at) => {
        const scope = `.k2-ui [data-k2-table="${id}"]`;
        const gone = new Set(
          steps()
            .slice(0, at + 1)
            .map((each) => each.column),
        );
        const widths = grid()
          ? []
          : props.columns.flatMap((column, index) => {
              const width = gone.has(index) ? undefined : colWidth(column, index, gone);
              const place = index + 1 + (props.select ? 1 : 0);
              return width ? [`${scope} col:nth-child(${place}) { --k2-col-w: ${width}; }`] : [];
            });
        return `@container k2-table (width < ${entry.below}px) { ${[hide(`${scope} [data-drop-step="${at + 1}"]`), ...widths].join(" ")} }`;
      })
      .join(" ");

  // the row object of each key of the tree now, so an item made once reads the newest one
  const rowsByKey = createMemo(() => {
    const out = new Map<string, T>();
    for (const entry of flat()) if ("row" in entry && entry.tree) out.set(key(entry.row, 0), entry.row);
    return out;
  });
  const treeItem = (rowKey: string, row: T, index: number, tree: TreePlace): TableItem<T> => ({
    get row() {
      return rowsByKey().get(rowKey) ?? row;
    },
    index,
    tree,
  });
  // the entries of a tree stay the same objects while nothing about their row changes, so its `tr` stays
  let lastItems = new Map<string, TableItem<T>>();
  const items = createMemo((): TableItem<T>[] => {
    const out: TableItem<T>[] = [];
    let last: string | undefined;
    let index = 0;
    const kept = new Map<string, TableItem<T>>();
    for (const entry of flat()) {
      if ("more" in entry) {
        const moreKey = `${MORE_ROW}${entry.more.parent ?? ""}`;
        const before = lastItems.get(moreKey);
        const same =
          before &&
          "more" in before &&
          (Object.keys(entry.more) as (keyof MoreRow)[]).every((name) => before.more[name] === entry.more[name]);
        const item = same ? before : { more: entry.more };
        kept.set(moreKey, item);
        out.push(item);
        continue;
      }
      const row = entry.row;
      const group = props.tree ? undefined : props.group?.(row);
      if (group && group.key !== last) out.push({ group });
      last = group?.key;
      const place = entry.tree;
      if (place) {
        const rowKey = key(row, index);
        const before = lastItems.get(rowKey);
        // A row keeps its element (and the focus in it) for as long as its key stays, also when the app hands a new
        // object for it (a refetch): the item reads its row by key, its place from `places`.
        const item = before && "row" in before ? before : treeItem(rowKey, row, index, place);
        kept.set(rowKey, item);
        out.push(item);
      } else out.push({ row, index });
      index += 1;
    }
    lastItems = kept;
    return out;
  });
  // where each row of the tree stands now, by its key
  const places = createMemo(() => {
    const out = new Map<string, TreePlace>();
    for (const entry of flat()) if ("row" in entry && entry.tree) out.set(key(entry.row, 0), entry.tree);
    return out;
  });
  const treeRows = createMemo((): TreegridRow[] =>
    flat().flatMap((item): TreegridRow[] => {
      if ("more" in item)
        return [
          { key: `${MORE_ROW}${item.more.parent ?? ""}`, level: item.more.level, parent: item.more.parent, branch: false, expanded: false },
        ];
      const place = item.tree;
      if (!place) return [];
      const rowKey = key(item.row, 0);
      return [
        {
          key: rowKey,
          level: place.level,
          parent: place.parent,
          branch: place.branch,
          expanded: place.expanded,
          busy: busy().includes(rowKey),
        },
      ];
    }),
  );
  // the one row Tab reaches: the last focused, else the open one, else the first
  const [focused, setFocused] = createSignal<string>();
  const rowKeys = createMemo(() => new Set(treeRows().map((row) => row.key)));
  const tabStop = createMemo(() => {
    const has = (rowKey: string | undefined) => rowKey !== undefined && rowKeys().has(rowKey);
    const last = focused();
    return has(last) ? last : has(props.current) ? props.current : treeRows()[0]?.key;
  });
  // each row asks whether it is the stop; a move of the stop updates two rows, not all of them
  const isTabStop = createSelector(tabStop);
  let body: HTMLTableSectionElement | undefined;
  // The focus a moved row lost goes to the page itself; a focus anywhere else is where the person went meanwhile.
  const focusLost = () => document.activeElement === null || document.activeElement === document.body;
  // the element of each row of the tree, by its key
  const rowElements = new Map<string, HTMLElement>();
  const rowRef = (rowKey: string) => (element: HTMLElement) => {
    rowElements.set(rowKey, element);
    onCleanup(() => {
      if (rowElements.get(rowKey) === element) rowElements.delete(rowKey);
    });
  };
  const focusRow = (rowKey: string) => {
    setFocused(rowKey);
    rowElements.get(rowKey)?.focus();
  };
  // New rows from the app (a refetch, another order) move row elements; a moved element loses the focus. The focused
  // key is noted before the rows change and gets the focus back once they are drawn.
  createComputed(
    on(
      flat,
      () => {
        const kept = body?.contains(document.activeElement) ? focused() : undefined;
        if (kept === undefined) return;
        requestAnimationFrame(() => {
          if (focusLost()) focusRow(kept);
        });
      },
      { defer: true },
    ),
  );
  const rowLabel = (element: Element | null | undefined) =>
    element?.querySelector(":scope > td:not([data-select]) .k2-cell-line")?.textContent?.trim() ?? "";
  const expand = (rowKey: string, label: string) => {
    const tree = props.tree;
    const entry = shownRows().find((shown, index) => key(shown.row, index) === rowKey);
    if (!tree || !entry || busy().includes(rowKey)) return;
    if (tree.children(entry.row) !== undefined || !tree.load) {
      setExpanded([...expanded().filter((other) => other !== rowKey), rowKey]);
      return;
    }
    const load = new AbortController();
    loads.set(rowKey, load);
    setBusy([...busy(), rowKey]);
    setFailed(failed().filter((other) => other !== rowKey));
    announceBranch(said(), "loading", label);
    const settle = (ok: boolean) => {
      if (load.signal.aborted) return;
      loads.delete(rowKey);
      setBusy(busy().filter((other) => other !== rowKey));
      if (ok) setExpanded([...expanded().filter((other) => other !== rowKey), rowKey]);
      else {
        setFailed([...failed(), rowKey]);
        announceBranch(said(), "load-failed", label);
      }
    };
    tree.load(entry.row, { signal: load.signal }).then(
      () => settle(true),
      () => settle(false),
    );
  };
  const collapse = (rowKey: string) => {
    // closing a row that is still loading stops the load
    loads.get(rowKey)?.abort();
    loads.delete(rowKey);
    setBusy(busy().filter((other) => other !== rowKey));
    setExpanded(expanded().filter((other) => other !== rowKey));
  };
  const toggleOpen = (rowKey: string, label: string) =>
    expanded().includes(rowKey) || busy().includes(rowKey) ? collapse(rowKey) : expand(rowKey, label);
  const [loadingMore, setLoadingMore] = createSignal<readonly string[]>([]);
  const [failedMore, setFailedMore] = createSignal<readonly string[]>([]);
  const loadMore = (more: { parent: string | null }) => {
    const tree = props.tree;
    const moreKey = `${MORE_ROW}${more.parent ?? ""}`;
    if (!tree?.loadMore || loadingMore().includes(moreKey)) return;
    const parent = more.parent === null ? null : (shownRows().find((shown, index) => key(shown.row, index) === more.parent)?.row ?? null);
    const before = treeRows().findIndex((row) => row.key === moreKey);
    // Whether the person waits on this row: only then does the focus follow the rows that come.
    const row = rowElements.get(moreKey);
    const waiting = row !== undefined && document.activeElement === row;
    const stillWaiting = () => {
      const active = document.activeElement;
      return active === row || active === null || active === document.body;
    };
    setLoadingMore([...loadingMore(), moreKey]);
    setFailedMore(failedMore().filter((other) => other !== moreKey));
    const settle = (ok: boolean) => {
      setLoadingMore(loadingMore().filter((other) => other !== moreKey));
      if (!ok) {
        setFailedMore([...failedMore(), moreKey]);
        announceText(t().loadMoreFailed);
        return;
      }
      // the focus goes on to the first row that came, which stands where the "Weitere laden" row stood
      const next = treeRows()[before];
      if (next && waiting && stillWaiting()) focusRow(next.key);
    };
    tree.loadMore(more.parent === null ? null : parent).then(
      () => settle(true),
      () => settle(false),
    );
  };
  const treeKey = (event: KeyboardEvent & { currentTarget: HTMLTableRowElement }, rowKey: string) => {
    if (event.target !== event.currentTarget) return;
    if (event.key === " " && props.select && !rowKey.startsWith(MORE_ROW)) {
      event.preventDefault();
      toggle(rowKey, !props.select.selected.includes(rowKey));
      return;
    }
    const step = treegridStep(treeRows(), rowKey, event);
    if (!step) return;
    event.preventDefault();
    if ("focus" in step) focusRow(step.focus);
    else if ("expand" in step) expand(step.expand, rowLabel(event.currentTarget));
    else if ("collapse" in step) collapse(step.collapse);
    else if (rowKey.startsWith(MORE_ROW)) loadMore({ parent: rowKey === MORE_ROW ? null : rowKey.slice(MORE_ROW.length) });
    else event.currentTarget.querySelector<HTMLElement>(".k2-row-open")?.click();
  };
  const selected = (row: T, index: number) => props.select?.selected.includes(key(row, index)) ?? false;
  // A click anywhere on a row that opens something opens it, unless it was meant for a control in the row.
  const openRow = (event: MouseEvent & { currentTarget: HTMLTableRowElement }) => {
    if (!(event.target instanceof Element) || event.target.closest("a, button, input, label, select, textarea")) return;
    const open = event.currentTarget.querySelector<HTMLElement>(".k2-row-open");
    if (!open || event.altKey) return;
    // With Ctrl, Cmd or Shift a link opens elsewhere, as on the link itself. A click handed on loses that in WebKit,
    // which follows it in this tab, so the row opens the link's address in a new tab itself.
    if (open instanceof HTMLAnchorElement && (event.ctrlKey || event.metaKey || event.shiftKey)) {
      window.open(open.href, "_blank", "noopener");
      return;
    }
    // a plain click is handed on to the link or button, which decides (`onNavigate`, `onOpen`, or the browser)
    open.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window, detail: event.detail }));
  };
  const all = (): boolean | "mixed" => {
    const count = props.select?.selected.length ?? 0;
    return count === 0 ? false : count === shownRows().length ? true : "mixed";
  };
  const toggle = (rowKey: string, on: boolean) => {
    const select = props.select;
    if (!select) return;
    select.onChange(on ? [...select.selected, rowKey] : select.selected.filter((selectedKey) => selectedKey !== rowKey));
  };
  const span = () => props.columns.length + (props.select ? 1 : 0);
  // The sticky first data column stands after the box column (44 px).
  const stickyLeft = () => (props.select ? "44px" : "0px");
  const firstSticky = (index: number) => (props.sticky && index === 0 ? "last" : undefined);

  const cell = (column: Column<T>, value: CellValue, target?: OpenTarget, row?: T, inTree = false) => {
    const lines = cellLines(column, value, target, inTree);
    // a cell that leads with the thing's mark or a person: the lead beside its lines, the lines cut as before
    const mark = row !== undefined ? column.mark?.(row) : undefined;
    const person = row !== undefined ? column.avatar?.(row) : undefined;
    if (!mark && !person) return lines;
    return (
      <span class="k2-cell-lead">
        {mark ? <Mark {...mark} /> : person ? <Avatar {...person} decorative /> : null}
        <span class="k2-cell-lines">{lines}</span>
      </span>
    );
  };
  const cellLines = (column: Column<T>, value: CellValue, target?: OpenTarget, inTree = false) => {
    // Every line of a cell is a block of its own: cut with "…" in a sized table, wrapped in a small one.
    const line = (content: JSX.Element, second = false) => (
      <span class="k2-cell-line" data-wrap={!second && column.wrap ? "" : undefined} data-second={second ? "" : undefined}>
        {content}
      </span>
    );
    const first = (content: JSX.Element) =>
      line(
        target ? (
          <RowOpen href={target.href} onNavigate={target.onNavigate} onOpen={target.onOpen} rowFocus={inTree}>
            {content}
          </RowOpen>
        ) : (
          content
        ),
      );
    if (!isPair(value)) return first(value);
    const [head, second] = value.lines;
    const parts = second === undefined ? first(head) : [first(head), line(second, true)];
    // a person leads the lines (the name stands in them, so the picture adds no name of its own)
    return value.avatar ? (
      <span class="k2-cell-person">
        <Avatar {...value.avatar} decorative />
        <span class="k2-cell-lines">{parts}</span>
      </span>
    ) : (
      parts
    );
  };

  const table = () => (
    <>
      <div
        class="k2-table-scroll"
        data-k2-part="Table"
        data-grid={grid() ? "" : undefined}
        data-wrap={props.columns.some((column) => column.wrap) ? "" : undefined}
        data-k2-table={steps().length > 0 ? id : undefined}
      >
        <Show when={steps().length > 0}>
          <style>{dropRule()}</style>
        </Show>
        {/* said outside the table, which is busy while its rows load */}
        <Show when={loading()}>
          <LoadingStatus />
        </Show>
        <table
          class="k2-table"
          data-lines={lines()}
          data-sized={sized() ? "" : undefined}
          data-grid={grid() ? "" : undefined}
          // a column that leads with the thing's mark makes every row 44 px with a mark of 32, as the mockup's lists
          data-marks={props.columns.some((column) => column.mark) ? "" : undefined}
          aria-label={props.label}
          aria-busy={loading() ? "true" : undefined}
          role={props.tree ? "treegrid" : undefined}
          data-tree={props.tree ? "" : undefined}
          style={least() ? { "min-width": `${least()}px` } : undefined}
        >
          <Show when={sized() || measured()}>
            <colgroup>
              <Show when={props.select}>
                <col style={{ width: "44px" }} />
              </Show>
              {/* every column between its minimum and default (a large table: its default), sharing the room left in a small
                  table; a numeric one at least as wide as its longest value. A column that drops leaves with its cells. */}
              <For each={props.columns}>
                {(column, index) => (
                  <col
                    data-drop={column.drop ? "" : undefined}
                    data-drop-step={step(index())}
                    style={custom({ "--k2-col-base": colWidth(column, index()) })}
                  />
                )}
              </For>
            </colgroup>
          </Show>
          <thead>
            <tr>
              <Show when={props.select}>
                {(select) => (
                  <th scope="col" data-select="" data-sticky={props.sticky ? "" : undefined}>
                    <MarkCheck
                      label={select().all}
                      checked={all()}
                      onChange={(on) => select().onChange(on ? shownRows().map((entry, index) => key(entry.row, index)) : [])}
                    />
                  </th>
                )}
              </Show>
              <For each={props.columns}>
                {(column, index) => (
                  <th
                    scope="col"
                    data-align={column.align}
                    data-numeric={isNumeric(column) ? "" : undefined}
                    data-drop={column.drop ? "" : undefined}
                    data-drop-step={step(index())}
                    data-sticky={firstSticky(index())}
                    style={firstSticky(index()) ? custom({ "--k2-sticky-left": stickyLeft() }) : undefined}
                    aria-sort={props.sort?.column === index() ? props.sort.direction : undefined}
                  >
                    {/* a grip only where the column before can be dragged; a fixed width has none */}
                    <Show when={index() > 0 ? resizable(props.columns[index() - 1]!) : undefined}>
                      {(width) => (
                        <ColumnGrip
                          label={props.columns[index() - 1]?.title ?? ""}
                          width={width()}
                          size={sizes()[index() - 1]}
                          onChange={(px) =>
                            setSizes((sizes) => {
                              const next = { ...sizes };
                              if (px === undefined) delete next[index() - 1];
                              else next[index() - 1] = px;
                              return next;
                            })
                          }
                        />
                      )}
                    </Show>
                    <Show
                      when={column.sort}
                      fallback={
                        <>
                          {column.title}
                          <SortArrow sorted={props.sort?.column === index() ? props.sort.direction : undefined} />
                        </>
                      }
                    >
                      {(target) => (
                        // the head itself is the link or button; `aria-sort` on the cell says the order
                        <Dynamic
                          component={linkOr(target().href, "button")}
                          type={target().href === undefined ? "button" : undefined}
                          href={target().href}
                          onNavigate={target().href !== undefined ? target().onNavigate : undefined}
                          onClick={() => target().onSort?.()}
                          class="k2-th-sort"
                        >
                          {column.title}
                          <SortArrow sorted={props.sort?.column === index() ? props.sort.direction : undefined} />
                        </Dynamic>
                      )}
                    </Show>
                  </th>
                )}
              </For>
            </tr>
          </thead>
          <tbody ref={body}>
            <Show when={loading()}>
              {(shape) => (
                <For each={Array.from({ length: shape().rows }, (_, index) => index)}>
                  {() => (
                    <tr data-loading="" aria-hidden="true">
                      <Show when={props.select}>
                        {/* the placeholder of the box stands where the box will stand */}
                        <td data-select="" data-sticky={props.sticky ? "" : undefined}>
                          <span class="k2-skel" data-box="" />
                        </td>
                      </Show>
                      <For each={props.columns}>
                        {(column, columnIndex) => (
                          <td
                            data-align={column.align}
                            data-numeric={isNumeric(column) ? "" : undefined}
                            data-drop={column.drop ? "" : undefined}
                            data-drop-step={step(columnIndex())}
                            data-sticky={firstSticky(columnIndex())}
                            style={firstSticky(columnIndex()) ? custom({ "--k2-sticky-left": stickyLeft() }) : undefined}
                          >
                            <span class="k2-cell-line">
                              <span class="k2-skel" />
                            </span>
                            <Show when={shape().lines === 2}>
                              <span class="k2-cell-line" data-second="">
                                <span class="k2-skel" />
                              </span>
                            </Show>
                          </td>
                        )}
                      </For>
                    </tr>
                  )}
                </For>
              )}
            </Show>
            <For each={loading() ? [] : items()}>
              {(item) =>
                "group" in item ? (
                  <tr data-group="">
                    <td colSpan={span()}>
                      <span class="k2-group-row">
                        {item.group.head()}
                        <Show when={item.group.count}>
                          <span class="k2-group-row-count">{item.group.count}</span>
                        </Show>
                        <Show when={item.group.meta}>
                          <span class="k2-group-row-meta">{item.group.meta}</span>
                        </Show>
                      </span>
                    </td>
                  </tr>
                ) : "more" in item ? (
                  (() => {
                    const moreKey = `${MORE_ROW}${item.more.parent ?? ""}`;
                    return (
                      <tr
                        ref={rowRef(moreKey)}
                        data-tree-row=""
                        data-more=""
                        data-open=""
                        data-failed={failedMore().includes(moreKey) ? "" : undefined}
                        tabindex={isTabStop(moreKey) ? 0 : -1}
                        aria-level={item.more.level}
                        aria-posinset={item.more.position}
                        aria-setsize={item.more.size}
                        aria-busy={loadingMore().includes(moreKey) ? "true" : undefined}
                        onKeyDown={(event) => treeKey(event, moreKey)}
                        onFocusIn={() => setFocused(moreKey)}
                        onClick={() => loadMore(item.more)}
                        style={custom({ "--k2-tree-level": String(item.more.level) })}
                      >
                        <td colSpan={span()} data-tree-cell="">
                          <span
                            class="k2-tree-chev"
                            data-loading={loadingMore().includes(moreKey) ? "" : undefined}
                            data-failed={failedMore().includes(moreKey) ? "" : undefined}
                            aria-hidden="true"
                          >
                            <Icon name="loader-2" />
                            <Icon name="alert-circle" />
                          </span>
                          <span class="k2-cell-line">
                            {failedMore().includes(moreKey)
                              ? t().loadMoreFailed
                              : t().loadMore({ count: item.more.count === true ? undefined : item.more.count })}
                          </span>
                        </td>
                      </tr>
                    );
                  })()
                ) : (
                  (() => {
                    // read again when the row's object changes (a refetch hands a new one for the same key)
                    const target = createMemo(() => props.open?.(item.row));
                    const rowKey = key(item.row, item.index);
                    // in a tree: the row's place now, read by its key (the element stays while the row stays)
                    const inTree = item.tree !== undefined;
                    const at = () => places().get(rowKey) ?? item.tree;
                    return (
                      <tr
                        data-open={target() ? "" : undefined}
                        data-selected={props.select && selected(item.row, item.index) ? "" : undefined}
                        aria-current={props.current !== undefined && props.current === rowKey ? "true" : undefined}
                        onClick={openRow}
                        data-tree-row={inTree ? "" : undefined}
                        ref={inTree ? rowRef(rowKey) : undefined}
                        tabindex={inTree ? (isTabStop(rowKey) ? 0 : -1) : undefined}
                        aria-level={at()?.level}
                        aria-posinset={at()?.position}
                        aria-setsize={at()?.size}
                        aria-expanded={at()?.branch ? (at()?.expanded ? "true" : "false") : undefined}
                        aria-selected={inTree && props.select ? (selected(item.row, item.index) ? "true" : "false") : undefined}
                        aria-busy={inTree && busy().includes(rowKey) ? "true" : undefined}
                        onKeyDown={inTree ? (event) => treeKey(event, rowKey) : undefined}
                        onFocusIn={inTree ? () => setFocused(rowKey) : undefined}
                        style={inTree ? custom({ "--k2-tree-level": String(at()?.level ?? 1) }) : undefined}
                      >
                        <Show when={props.select}>
                          {(select) => (
                            <td data-select="" data-sticky={props.sticky ? "" : undefined}>
                              <MarkCheck
                                label={select().row(item.row)}
                                checked={selected(item.row, item.index)}
                                onChange={(on) => toggle(rowKey, on)}
                                // in a tree the row takes the focus and Space selects it
                                focusable={inTree ? false : undefined}
                              />
                            </td>
                          )}
                        </Show>
                        <For each={props.columns}>
                          {(column, columnIndex) => (
                            <td
                              data-align={column.align}
                              data-numeric={isNumeric(column) ? "" : undefined}
                              data-drop={column.drop ? "" : undefined}
                              data-drop-step={step(columnIndex())}
                              data-sticky={firstSticky(columnIndex())}
                              data-tree-cell={inTree && columnIndex() === 0 ? "" : undefined}
                              style={firstSticky(columnIndex()) ? custom({ "--k2-sticky-left": stickyLeft() }) : undefined}
                            >
                              <Show when={inTree && columnIndex() === 0 ? at() : undefined}>
                                {(at) => (
                                  // the arrow folds the row open and shut; Right and Left on the row do the same
                                  <span
                                    class="k2-tree-chev"
                                    aria-hidden="true"
                                    data-branch={at().branch ? "" : undefined}
                                    data-expanded={at().expanded ? "" : undefined}
                                    data-loading={busy().includes(rowKey) ? "" : undefined}
                                    data-failed={failed().includes(rowKey) && !busy().includes(rowKey) ? "" : undefined}
                                    onClick={(event) => {
                                      if (!at().branch) return;
                                      event.stopPropagation();
                                      toggleOpen(rowKey, rowLabel(event.currentTarget.closest("tr")));
                                    }}
                                  >
                                    <Show when={at().branch}>
                                      <Icon name="chevron-right" />
                                      <Icon name="loader-2" />
                                      <Icon name="alert-circle" />
                                    </Show>
                                  </span>
                                )}
                              </Show>
                              {cell(column, cellsOf(item)[columnIndex()]!, columnIndex() === 0 ? target() : undefined, item.row, inTree)}
                            </td>
                          )}
                        </For>
                      </tr>
                    );
                  })()
                )
              }
            </For>
          </tbody>
        </table>
      </div>
      <Show when={props.phone}>
        {(phone) => (
          <div class="k2-table-phone">
            {/* while the rows load, the phone shows rows of placeholders of two lines, not an empty list */}
            <Show when={!loading()} fallback={<Loading rows={loading()?.rows} lines={2} />}>
              <List label={props.label}>
                {/* a tree shows its top level on the phone; its rows open as pages */}
                <For
                  each={items().filter(
                    (item) =>
                      ("row" in item
                        ? item.tree
                          ? (places().get(key(item.row, item.index))?.level ?? 1)
                          : 1
                        : "more" in item
                          ? item.more.level
                          : 1) === 1,
                  )}
                >
                  {(item) =>
                    "group" in item ? (
                      // the same head as in the table: text in 600 with its count, no band and no line under it
                      <div class="k2-table-phone-group" role="presentation">
                        <span class="k2-group-row">
                          {item.group.head()}
                          <Show when={item.group.count}>
                            <span class="k2-group-row-count">{item.group.count}</span>
                          </Show>
                          <Show when={item.group.meta}>
                            <span class="k2-group-row-meta">{item.group.meta}</span>
                          </Show>
                        </span>
                      </div>
                    ) : "more" in item ? (
                      <div class="k2-bar" role="presentation">
                        <div class="k2-bar-start">
                          <ActionButton
                            action={{
                              label: t().loadMore({ count: item.more.count === true ? undefined : item.more.count }),
                              onClick: () => loadMore(item.more),
                            }}
                            variant="text"
                          />
                        </div>
                      </div>
                    ) : (
                      (() => {
                        // read again when the row's object changes (a refetch hands a new one for the same key)
                        const form = createMemo(() => phone()(item.row));
                        const target = createMemo(() => props.open?.(item.row));
                        // the lines are clamped (the title to two lines, the line under it to one): words cut so say
                        // all of them on hover
                        const tip = (line: JSX.Element) => (typeof line === "string" ? <span title={line}>{line}</span> : line);
                        return (
                          <Row
                            lines={[tip(form().lines[0]), tip(form().lines[1])]}
                            avatar={form().avatar}
                            mark={form().mark}
                            time={form().time}
                            marks={form().marks}
                            end={form().end}
                            strong
                            href={target()?.href}
                            onNavigate={target()?.onNavigate}
                            onOpen={target()?.onOpen}
                            current={props.current !== undefined && props.current === key(item.row, item.index)}
                            select={
                              props.select
                                ? {
                                    selected: selected(item.row, item.index),
                                    onChange: (on) => toggle(key(item.row, item.index), on),
                                  }
                                : undefined
                            }
                          />
                        );
                      })()
                    )
                  }
                </For>
              </List>
            </Show>
          </div>
        )}
      </Show>
    </>
  );

  return (
    <Show when={empty()} fallback={table()}>
      {(state) => <Empty {...state()} />}
    </Show>
  );
};

// ── QrCode, CodeDisplay ──────────────────────────────────────────────────────────────────────────────────────────

export type QrCodeProps = {
  /** The QR code as SVG markup, such as `qr.toSvg(link)` from `@k2b/stdlib/qr`; dark on light in both themes. */
  svg: string;
  /** What the code is for, for assistive technology, such as "QR-Code zum Koppeln". */
  label: string;
};

/**
 * A QR code to scan with another device: 192 px on a white well with its quiet zone, in the middle of its column, white
 * also in the dark theme so every camera reads it. The SVG is shown as a picture, so markup in it never runs.
 */
export const QrCode = (props: QrCodeProps) => (
  <span class="k2-qr" data-k2-part="QrCode">
    <img src={`data:image/svg+xml,${encodeURIComponent(props.svg)}`} alt={props.label} width="192" height="192" />
  </span>
);

export type CodeDisplayProps = {
  /** The code as both devices show it, such as "482 913"; spaces group it. */
  value: string;
  /** What to do with it, for assistive technology, such as "Vergleichscode". */
  label: string;
};

/**
 * A code a person compares between two devices or reads aloud: large monospaced figures in the middle of its column.
 * Assistive technology hears its label and the characters one by one, not as one large number.
 */
export const CodeDisplay = (props: CodeDisplayProps) => (
  <p
    class="k2-bigcode"
    data-k2-part="CodeDisplay"
    // figures to compare at a glance across a room: the one text of v2 larger than the type roles
    data-k2-untyped=""
    role="img"
    aria-label={`${props.label}: ${[...props.value.replace(/\s+/g, "")].join(" ")}`}
  >
    {props.value}
  </p>
);
