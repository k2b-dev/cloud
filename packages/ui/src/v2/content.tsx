import { Link } from "@k2b/ssr/nav";
import {
  createContext,
  createMemo,
  createSignal,
  createUniqueId,
  For,
  type JSX,
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
import { useUiMessages } from "../intl/messages";
import { useBehaviorMessages } from "./behavior/messages";
import { announceBranch, type TreegridRow, treegridStep } from "./behavior/treegrid";
import { ActionButton, CopyButton } from "./button";
import { MarkCheck } from "./controls";
import { linkOr } from "./link";
import { Avatar, custom, Dot, Icon } from "./marks";
import { Empty, type EmptyProps, Loading, LoadingStatus } from "./states";
import type { TypeRole } from "./tokens";
import type { Action, OnNavigate, Person, Status } from "./types";

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
};

/**
 * Values with their labels: label 12 quiet, value 13, 32 px a row, copy at the value. The label column is as wide as
 * the longest label, at least 80 px and at most 160 px.
 */
export const Facts = (props: FactsProps) => {
  // A list of pairs (dt, dd); a copy button stands inside its value, the end of an inline line beside the list.
  const list = (part?: string) => (
    <dl class="k2-facts" data-k2-part={part} data-inline={props.inline ? "" : undefined}>
      <For each={props.items}>
        {(item) => (
          <div class="k2-fact-pair">
            <dt>{item.label}</dt>
            <dd>
              <span class="k2-fact-value" data-mono={item.mono ? "" : undefined}>
                {item.value}
                <Show when={item.hint}>
                  <small>{item.hint}</small>
                </Show>
              </span>
              <Show when={!props.inline && item.copy}>{(value) => <CopyButton label={item.label} value={value()} />}</Show>
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
  /** The lead: a symbol in the colour of its area … */
  icon?: string;
  /** … the data colour of that symbol … */
  color?: string;
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
   * lead's symbol, person or dot. Open and selected combine: a selected row stays blue, and stays the open one.
   */
  select?: { selected: boolean; onChange: (selected: boolean) => void };
  /** "You are next", in the blue tint. */
  yours?: boolean;
  /** Top right, quiet: a time or a date. */
  time?: JSX.Element;
  /** Bottom right on the third line: chips, icons, people. */
  marks?: JSX.Element;
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
      data-time={time() !== undefined ? "" : undefined}
      data-action={props.action ? "" : undefined}
      style={custom({ "--k2-c": props.color })}
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
      <span class="k2-row-lead">
        <Show
          when={props.select}
          fallback={
            <Show
              when={props.avatar}
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
              {(person) => <Avatar {...person()} />}
            </Show>
          }
        >
          {(select) => <MarkCheck labelledBy={title} checked={select().selected} onChange={(on) => select().onChange(on)} />}
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
    </div>
  );
};

// ── Table ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Two lines of a cell: the line itself and a quiet second line under it. */
export type CellLines = { lines: readonly [JSX.Element, JSX.Element] };

/** What a cell shows: one line, or two lines named as such (`{ lines: [first, second] }`). */
export type CellValue = JSX.Element | CellLines;

export type Column<T> = {
  /** The head of the column. */
  title: string;
  /** What a cell shows: one line, or two lines named as such. */
  cell: (row: T) => CellValue;
  /** Numbers and amounts stand at the end. */
  align?: "start" | "end";
  /**
   * A column that can be dragged wider or narrower: its minimum and default in px. The column is exactly its
   * default wide; cut text never widens it.
   */
  width?: { min: number; default: number };
  /** A text column that may wrap to at most three lines; the row grows, every other cell stays on its first line. */
  wrap?: boolean;
  /** Drops away on the phone (rule 7: columns drop, they do not shrink). */
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
  phone?: (row: T) => { lines: readonly [JSX.Element, JSX.Element]; avatar?: Person; time?: JSX.Element; marks?: JSX.Element };
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
  /** Rows of a group follow one another under a tinted group row of 36 px (no frame: it would cut the columns). */
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

/** Two lines only when they are named so: an array of two parts (a fragment) stays one line. */
const isPair = (value: CellValue): value is CellLines =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  !(typeof Node !== "undefined" && value instanceof Node) &&
  "lines" in value;

/**
 * A group of rows: its key, its head (such as a state chip), quiet figures after it, and the count for the phone.
 * The head is made where it stands (the table and the phone list each make their own), so it is a function.
 */
export type TableGroup = { key: string; head: () => JSX.Element; meta?: string; count?: string };

/** Where a row stands in the tree: its level, its place among its siblings and whether it is an open branch. */
type TreePlace = { level: number; parent: string | null; position: number; size: number; branch: boolean; expanded: boolean };

type TableItem<T> =
  | { group: TableGroup }
  | { row: T; index: number; tree?: TreePlace }
  | { more: { parent: string | null; level: number; count: true | number } };

// The key of the "Weitere laden" row of a level; no row key starts with a word joiner.
const MORE_ROW = "\u2060more:";

/**
 * Many like things in columns: head 36, a line under every row, none between columns. Long text stays on one line
 * with "…" and a fixed row height (variant a, decided 22.11.); `wrap` lets one text column take three lines. With
 * `select` or `sticky` it is the large table of Grids: one scroller for head and rows, a sticky head and first column,
 * rows and cells under the pointer, groups as tinted rows.
 */
export const Table = <T,>(props: TableProps<T>) => {
  const t = useUiMessages();
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
        if (!body?.contains(document.activeElement)) focusRow(kept);
      });
  };
  const [busy, setBusy] = createSignal<readonly string[]>([]);
  const [failed, setFailed] = createSignal<readonly string[]>([]);
  const loads = new Map<string, AbortController>();
  onCleanup(() => loads.forEach((load) => load.abort()));

  // What shows, in reading order: the rows, the children of open rows under them, and a "Weitere laden" row after a
  // level that has more. Without `tree`, the rows themselves.
  const flat = createMemo(
    (): ({ row: T; tree?: TreePlace } | { more: { parent: string | null; level: number; count: true | number } })[] => {
      const tree = props.tree;
      if (!tree) return props.rows.map((row) => ({ row }));
      const open = new Set(expanded());
      const out: ({ row: T; tree: TreePlace } | { more: { parent: string | null; level: number; count: true | number } })[] = [];
      const walk = (list: readonly T[], parent: T | null, parentKey: string | null, level: number) => {
        list.forEach((row, index) => {
          const rowKey = key(row, index);
          const branch = tree.branch(row);
          const isOpen = branch && open.has(rowKey) && tree.children(row) !== undefined;
          out.push({ row, tree: { level, parent: parentKey, position: index + 1, size: list.length, branch, expanded: isOpen } });
          if (isOpen) walk(tree.children(row) ?? [], row, rowKey, level + 1);
        });
        const more = tree.loadMore ? tree.more?.(parent) : undefined;
        if (more !== undefined) out.push({ more: { parent: parentKey, level, count: more } });
      };
      walk(props.rows, null, null, 1);
      return out;
    },
  );
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
  // the shape of the placeholders while the rows load
  const loading = () => {
    const shape = props.loading;
    return shape === true ? { rows: 3, lines: 1 as const } : shape ? { rows: shape.rows ?? 3, lines: shape.lines ?? 1 } : undefined;
  };
  const empty = () => (loading() || props.rows.length > 0 ? undefined : props.empty);
  const lines = () => (loading()?.lines === 2 || values().some((row) => row.some(isPair)) ? "2" : "1");
  // the entries of a tree stay the same objects while nothing about their row changes, so its `tr` stays
  let lastItems = new Map<string, TableItem<T>>();
  const items = createMemo((): TableItem<T>[] => {
    const out: TableItem<T>[] = [];
    let last: string | undefined;
    let index = 0;
    const kept = new Map<string, TableItem<T>>();
    for (const entry of flat()) {
      if ("more" in entry) {
        out.push({ more: entry.more });
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
        const same =
          before &&
          "row" in before &&
          before.row === row &&
          before.index === index &&
          before.tree !== undefined &&
          (Object.keys(place) as (keyof TreePlace)[]).every((name) => before.tree?.[name] === place[name]);
        const item = same ? before : { row, index, tree: place };
        kept.set(rowKey, item);
        out.push(item);
      } else out.push({ row, index });
      index += 1;
    }
    lastItems = kept;
    return out;
  });
  const treeRows = createMemo((): TreegridRow[] =>
    items().flatMap((item): TreegridRow[] => {
      if ("group" in item) return [];
      if ("more" in item)
        return [
          { key: `${MORE_ROW}${item.more.parent ?? ""}`, level: item.more.level, parent: item.more.parent, branch: false, expanded: false },
        ];
      const place = item.tree;
      return place
        ? [{ key: key(item.row, item.index), level: place.level, parent: place.parent, branch: place.branch, expanded: place.expanded }]
        : [];
    }),
  );
  // the one row Tab reaches: the last focused, else the open one, else the first
  const [focused, setFocused] = createSignal<string>();
  const tabStop = () => {
    const rows = treeRows();
    const has = (rowKey: string | undefined) => rowKey !== undefined && rows.some((row) => row.key === rowKey);
    const last = focused();
    return has(last) ? last : has(props.current) ? props.current : rows[0]?.key;
  };
  let body: HTMLTableSectionElement | undefined;
  const focusRow = (rowKey: string) => {
    setFocused(rowKey);
    const at = treeRows().findIndex((row) => row.key === rowKey);
    body?.querySelectorAll<HTMLElement>(":scope > tr[data-tree-row]")[at]?.focus();
  };
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
  const loadMore = (more: { parent: string | null }) => {
    const tree = props.tree;
    const moreKey = `${MORE_ROW}${more.parent ?? ""}`;
    if (!tree?.loadMore || loadingMore().includes(moreKey)) return;
    const parent = more.parent === null ? null : (shownRows().find((shown, index) => key(shown.row, index) === more.parent)?.row ?? null);
    const before = treeRows().findIndex((row) => row.key === moreKey);
    setLoadingMore([...loadingMore(), moreKey]);
    const done = () => {
      setLoadingMore(loadingMore().filter((other) => other !== moreKey));
      // the focus goes on to the first row that came, which stands where the "Weitere laden" row stood
      const next = treeRows()[before];
      if (next && body?.contains(document.activeElement)) requestAnimationFrame(() => focusRow(next.key));
    };
    tree.loadMore(more.parent === null ? null : parent).then(done, done);
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

  const cell = (column: Column<T>, value: CellValue, target?: OpenTarget, inTree = false) => {
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
    return isPair(value) ? [first(value.lines[0]), line(value.lines[1], true)] : first(value);
  };

  const table = () => (
    <>
      <div
        class="k2-table-scroll"
        data-k2-part="Table"
        data-grid={grid() ? "" : undefined}
        data-wrap={props.columns.some((column) => column.wrap) ? "" : undefined}
      >
        {/* said outside the table, which is busy while its rows load */}
        <Show when={loading()}>
          <LoadingStatus />
        </Show>
        <table
          class="k2-table"
          data-lines={lines()}
          data-sized={sized() ? "" : undefined}
          data-grid={grid() ? "" : undefined}
          aria-label={props.label}
          aria-busy={loading() ? "true" : undefined}
          role={props.tree ? "treegrid" : undefined}
          data-tree={props.tree ? "" : undefined}
        >
          <Show when={sized()}>
            <colgroup>
              <Show when={props.select}>
                <col style={{ width: "44px" }} />
              </Show>
              {/* every column is its default wide; in a small table the last one takes the rest of the row */}
              <For each={props.columns}>
                {(column, index) => (
                  <col
                    style={
                      column.width && (grid() || index() < props.columns.length - 1) ? { width: `${column.width.default}px` } : undefined
                    }
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
                    data-drop={column.drop ? "" : undefined}
                    data-sticky={firstSticky(index())}
                    style={firstSticky(index()) ? custom({ "--k2-sticky-left": stickyLeft() }) : undefined}
                    aria-sort={props.sort?.column === index() ? props.sort.direction : undefined}
                  >
                    <Show when={index() > 0 && props.columns[index() - 1]?.width}>
                      <span
                        class="k2-cgrip"
                        role="separator"
                        aria-orientation="vertical"
                        aria-label={props.columns[index() - 1]!.title}
                        aria-valuemin={props.columns[index() - 1]!.width!.min}
                        aria-valuenow={props.columns[index() - 1]!.width!.default}
                        tabindex="0"
                      />
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
                            data-drop={column.drop ? "" : undefined}
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
                        data-tree-row=""
                        data-more=""
                        data-open=""
                        tabindex={tabStop() === moreKey ? 0 : -1}
                        aria-level={item.more.level}
                        aria-busy={loadingMore().includes(moreKey) ? "true" : undefined}
                        onKeyDown={(event) => treeKey(event, moreKey)}
                        onFocusIn={() => setFocused(moreKey)}
                        onClick={() => loadMore(item.more)}
                        style={custom({ "--k2-tree-level": String(item.more.level) })}
                      >
                        <td colSpan={span()} data-tree-cell="">
                          <span class="k2-tree-chev" data-loading={loadingMore().includes(moreKey) ? "" : undefined} aria-hidden="true">
                            <Icon name="loader-2" />
                          </span>
                          <span class="k2-cell-line">
                            {t().loadMore({ count: item.more.count === true ? undefined : item.more.count })}
                          </span>
                        </td>
                      </tr>
                    );
                  })()
                ) : (
                  (() => {
                    const target = props.open?.(item.row);
                    const rowKey = key(item.row, item.index);
                    const place = item.tree;
                    return (
                      <tr
                        data-open={target ? "" : undefined}
                        data-selected={props.select && selected(item.row, item.index) ? "" : undefined}
                        aria-current={props.current !== undefined && props.current === rowKey ? "true" : undefined}
                        onClick={target ? openRow : undefined}
                        data-tree-row={place ? "" : undefined}
                        tabindex={place ? (tabStop() === rowKey ? 0 : -1) : undefined}
                        aria-level={place?.level}
                        aria-posinset={place?.position}
                        aria-setsize={place?.size}
                        aria-expanded={place?.branch ? (place.expanded ? "true" : "false") : undefined}
                        aria-selected={place && props.select ? (selected(item.row, item.index) ? "true" : "false") : undefined}
                        aria-busy={place && busy().includes(rowKey) ? "true" : undefined}
                        onKeyDown={place ? (event) => treeKey(event, rowKey) : undefined}
                        onFocusIn={place ? () => setFocused(rowKey) : undefined}
                        style={place ? custom({ "--k2-tree-level": String(place.level) }) : undefined}
                      >
                        <Show when={props.select}>
                          {(select) => (
                            <td data-select="" data-sticky={props.sticky ? "" : undefined}>
                              <MarkCheck
                                label={select().row(item.row)}
                                checked={selected(item.row, item.index)}
                                onChange={(on) => toggle(rowKey, on)}
                              />
                            </td>
                          )}
                        </Show>
                        <For each={props.columns}>
                          {(column, columnIndex) => (
                            <td
                              data-align={column.align}
                              data-drop={column.drop ? "" : undefined}
                              data-sticky={firstSticky(columnIndex())}
                              data-tree-cell={place && columnIndex() === 0 ? "" : undefined}
                              style={firstSticky(columnIndex()) ? custom({ "--k2-sticky-left": stickyLeft() }) : undefined}
                            >
                              <Show when={place && columnIndex() === 0 && place}>
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
                              {cell(
                                column,
                                values()[item.index]![columnIndex()]!,
                                columnIndex() === 0 ? target : undefined,
                                place !== undefined,
                              )}
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
                  each={items().filter((item) => ("row" in item ? (item.tree?.level ?? 1) : "more" in item ? item.more.level : 1) === 1)}
                >
                  {(item) =>
                    "group" in item ? (
                      <div class="k2-bar" role="presentation">
                        <div class="k2-bar-start">
                          {item.group.head()}
                          <Show when={item.group.count ?? item.group.meta}>
                            <span class="k2-t-meta">{item.group.count ?? item.group.meta}</span>
                          </Show>
                        </div>
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
                        const form = phone()(item.row);
                        const target = props.open?.(item.row);
                        return (
                          <Row
                            lines={form.lines}
                            avatar={form.avatar}
                            time={form.time}
                            marks={form.marks}
                            strong
                            href={target?.href}
                            onNavigate={target?.onNavigate}
                            onOpen={target?.onOpen}
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
