import { createContext, createMemo, createUniqueId, For, type JSX, children as resolveChildren, Show, useContext } from "solid-js";
import { Dynamic } from "solid-js/web";
import { renderSafeMarkdown } from "../content/MarkdownView";
import { useLocale } from "../intl/locale";
import { ActionButton, CopyButton } from "./button";
import { MarkCheck } from "./controls";
import { Avatar, custom, Dot, Icon } from "./marks";
import type { TypeRole } from "./tokens";
import type { Action, Person, Status } from "./types";

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
  | { markdown?: never; children: JSX.Element };

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

/** One line of things with the one fixed gap of 8 px. In a column it carries the text edge itself. */
export const Inline = (props: InlineProps) => (
  <div class="k2-inline" data-k2-part="Inline">
    {props.children}
  </div>
);

// ── Facts ────────────────────────────────────────────────────────────────────────────────────────────────────────

export type Fact = {
  label: string;
  value: JSX.Element;
  /** A quiet word under the value, such as "Standard". */
  hint?: string;
  /** Offers a copy button at the value; the text that is copied. */
  copy?: string;
};

export type FactsProps = {
  items: readonly Fact[];
  /** All facts on one line, labels quiet before their values. */
  inline?: boolean;
  /** At the end of the inline line, such as "Print". */
  end?: JSX.Element;
};

/** Values with their labels: label 12 quiet, value 13, 32 px a row, copy at the value. */
export const Facts = (props: FactsProps) => {
  // A list of pairs (dt, dd); a copy button stands inside its value, the end of an inline line beside the list.
  const list = (part?: string) => (
    <dl class="k2-facts" data-k2-part={part} data-inline={props.inline ? "" : undefined}>
      <For each={props.items}>
        {(item) => (
          <div class="k2-fact-pair">
            <dt>{item.label}</dt>
            <dd>
              <span class="k2-fact-value">
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

export type ListProps = { children: JSX.Element; label?: string };

/** Rows one under the other. (Selection, keyboard and drag come with the behaviour layer.) */
export const List = (props: ListProps) => (
  <div class="k2-list" data-k2-part="List" role="list" aria-label={props.label}>
    <ListContext.Provider value={true}>{props.children}</ListContext.Provider>
  </div>
);

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
  /** The open one, in the tint of the app. */
  selected?: boolean;
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
  /** … or calls this. */
  onOpen?: () => void;
};

/**
 * What opens an entry: the title becomes a link or a button, stretched over the whole entry. It is never the entry
 * itself, so buttons and links inside the entry stay buttons and links of their own (no control inside a control).
 */
export const RowOpen = (props: { href?: string; onOpen?: () => void; children: JSX.Element }) => (
  <Show when={props.href !== undefined || props.onOpen} fallback={props.children}>
    <Show
      when={props.href !== undefined}
      fallback={
        <button type="button" class="k2-row-open" onClick={() => props.onOpen?.()}>
          {props.children}
        </button>
      }
    >
      <a class="k2-row-open" href={props.href} onClick={() => props.onOpen?.()}>
        {props.children}
      </a>
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
      data-selected={props.selected ? "" : undefined}
      aria-current={props.selected ? "true" : undefined}
      data-yours={props.yours ? "" : undefined}
      data-avatar={props.avatar ? "" : undefined}
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
          {/* biome-ignore lint/a11y/useAnchorContent: the row's title names it through aria-labelledby; holding the title would put a link of the title inside this one. */}
          <a class="k2-row-open" href={props.href} aria-labelledby={title} onClick={() => props.onOpen?.()} />
        </Show>
      </Show>
      <span class="k2-row-lead">
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
  title: string;
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
};

/** Where an entry leads: a page (a real link, also before the page is live) or a deed in place. */
export type OpenTarget = { href: string; onOpen?: () => void } | { href?: undefined; onOpen: () => void };

type TableBase<T> = {
  columns: readonly Column<T>[];
  rows: readonly T[];
  /** A name for the table, for assistive technology. */
  label?: string;
  /** The first column (and the box column) stays while the table scrolls sideways; an edge shows behind it. */
  sticky?: boolean;
  /** The column the rows are sorted by: an arrow in its head. */
  sort?: { column: number; direction: "ascending" | "descending" };
  /** What a row opens, on the desktop and on the phone: its first cell is the link or button. */
  open?: (row: T) => OpenTarget;
  /** On the phone each row becomes a row of two lines instead (rule 7). */
  phone?: (row: T) => { lines: readonly [JSX.Element, JSX.Element]; avatar?: Person; time?: JSX.Element };
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
};

type PlainTable = { rowKey?: undefined; select?: undefined; current?: undefined; group?: undefined };

export type TableProps<T> = TableBase<T> & (KeyedTable<T> | PlainTable);

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

type TableItem<T> = { group: TableGroup } | { row: T; index: number };

/**
 * Many like things in columns: head 36, a line under every row, none between columns. Long text stays on one line
 * with "…" and a fixed row height (variant a, decided 22.11.); `wrap` lets one text column take three lines. With
 * `select` or `sticky` it is the large table of Grids: one scroller for head and rows, a sticky head and first column,
 * rows and cells under the pointer, groups as tinted rows.
 */
export const Table = <T,>(props: TableProps<T>) => {
  const grid = () => props.select !== undefined || props.sticky === true;
  const sized = () => grid() || props.columns.some((column) => column.width);
  // Every cell is made once: what `cell` returns is placed, never rendered a second time.
  const values = createMemo(() => props.rows.map((row) => props.columns.map((column) => column.cell(row))));
  const lines = () => (values().some((row) => row.some(isPair)) ? "2" : "1");
  const key = (row: T, index: number) => props.rowKey?.(row) ?? String(index);
  const items = createMemo((): TableItem<T>[] => {
    const out: TableItem<T>[] = [];
    let last: string | undefined;
    props.rows.forEach((row, index) => {
      const group = props.group?.(row);
      if (group && group.key !== last) out.push({ group });
      last = group?.key;
      out.push({ row, index });
    });
    return out;
  });
  const selected = (row: T, index: number) => props.select?.selected.includes(key(row, index)) ?? false;
  // A click anywhere on a row that opens something opens it, unless it was meant for a control in the row.
  const openRow = (event: MouseEvent & { currentTarget: HTMLTableRowElement }) => {
    if (!(event.target instanceof Element) || event.target.closest("a, button, input, label, select, textarea")) return;
    event.currentTarget.querySelector<HTMLElement>(".k2-row-open")?.click();
  };
  const all = (): boolean | "mixed" => {
    const count = props.select?.selected.length ?? 0;
    return count === 0 ? false : count === props.rows.length ? true : "mixed";
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

  const cell = (column: Column<T>, value: CellValue, target?: OpenTarget) => {
    // Every line of a cell is a block of its own: cut with "…" in a sized table, wrapped in a small one.
    const line = (content: JSX.Element, second = false) => (
      <span class="k2-cell-line" data-wrap={!second && column.wrap ? "" : undefined} data-second={second ? "" : undefined}>
        {content}
      </span>
    );
    const first = (content: JSX.Element) =>
      line(
        target ? (
          <RowOpen href={target.href} onOpen={target.onOpen}>
            {content}
          </RowOpen>
        ) : (
          content
        ),
      );
    return isPair(value) ? [first(value.lines[0]), line(value.lines[1], true)] : first(value);
  };

  return (
    <>
      <div
        class="k2-table-scroll"
        data-k2-part="Table"
        data-grid={grid() ? "" : undefined}
        data-wrap={props.columns.some((column) => column.wrap) ? "" : undefined}
      >
        <table
          class="k2-table"
          data-lines={lines()}
          data-sized={sized() ? "" : undefined}
          data-grid={grid() ? "" : undefined}
          aria-label={props.label}
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
                    <MarkCheck label={select().all} checked={all()} onChange={(on) => select().onChange(on ? props.rows.map(key) : [])} />
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
                    {column.title}
                    <Show when={props.sort?.column === index()}>
                      <Icon name={props.sort?.direction === "descending" ? "arrow-down" : "arrow-up"} />
                    </Show>
                  </th>
                )}
              </For>
            </tr>
          </thead>
          <tbody>
            <For each={items()}>
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
                ) : (
                  (() => {
                    const target = props.open?.(item.row);
                    return (
                      <tr
                        data-open={target ? "" : undefined}
                        data-selected={props.select && selected(item.row, item.index) ? "" : undefined}
                        aria-current={props.current !== undefined && props.current === key(item.row, item.index) ? "true" : undefined}
                        onClick={target ? openRow : undefined}
                      >
                        <Show when={props.select}>
                          {(select) => (
                            <td data-select="" data-sticky={props.sticky ? "" : undefined}>
                              <MarkCheck
                                label={select().row(item.row)}
                                checked={selected(item.row, item.index)}
                                onChange={(on) => toggle(key(item.row, item.index), on)}
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
                              style={firstSticky(columnIndex()) ? custom({ "--k2-sticky-left": stickyLeft() }) : undefined}
                            >
                              {cell(column, values()[item.index]![columnIndex()]!, columnIndex() === 0 ? target : undefined)}
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
            <List label={props.label}>
              <For each={items()}>
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
                  ) : (
                    (() => {
                      const form = phone()(item.row);
                      const target = props.open?.(item.row);
                      return (
                        <Row
                          lines={form.lines}
                          avatar={form.avatar}
                          time={form.time}
                          strong
                          href={target?.href}
                          onOpen={target?.onOpen}
                          selected={props.current !== undefined && props.current === key(item.row, item.index)}
                        />
                      );
                    })()
                  )
                }
              </For>
            </List>
          </div>
        )}
      </Show>
    </>
  );
};
