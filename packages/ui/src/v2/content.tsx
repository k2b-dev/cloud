import { createContext, For, type JSX, Show, useContext } from "solid-js";
import { Dynamic } from "solid-js/web";
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
  /** 600: the one way to stress a word. Emphasis is a weight, never a size. */
  strong?: boolean;
  /** 500: a state or an amount that stands out a little, such as "Quittung offen". */
  medium?: boolean;
  /** The muted ink, for a second voice beside the main text. */
  muted?: boolean;
  /** A colour of meaning, never decoration. */
  tone?: Status | "ai" | "draft";
  /** The words lead to this page: they keep the ink of the text and are underlined (blue is only the main action). */
  href?: string;
  children: JSX.Element;
};

/**
 * Text in one of the four type roles. Standing in the flow of a column (a pane, a band, a section, a group) it is a
 * block that carries the text edge itself; anywhere else (a bar, a row, a sentence) it runs inline, and in a bar it is
 * cut to one line with "…". The stylesheet decides by place, so text passed as data behaves the same.
 */
export const Text = (props: TextProps) => (
  <Dynamic
    component={props.href ? "a" : "span"}
    href={props.href}
    class={`k2-text${props.type ? ` k2-t-${props.type}` : ""}${props.strong ? " k2-strong" : props.medium ? " k2-medium" : ""}${props.muted ? " k2-muted" : ""}${props.href ? " k2-link" : ""}`}
    data-k2-part="Text"
    data-type={props.type}
    data-tone={props.tone}
  >
    {props.children}
  </Dynamic>
);

export type ProseProps = { html: string; children?: never } | { html?: never; children: JSX.Element };

/** Reading text: 14/22, a measure of 720 px, headings at 16 and 18. It carries the text edge itself. */
export const Prose = (props: ProseProps) => (
  <Show
    when={props.html !== undefined}
    fallback={
      <div class="k2-prose" data-k2-part="Prose" data-k2-prose="">
        {props.children}
      </div>
    }
  >
    <div class="k2-prose" data-k2-part="Prose" data-k2-prose="" innerHTML={props.html} />
  </Show>
);

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
export const Facts = (props: FactsProps) => (
  <dl class="k2-facts" data-k2-part="Facts" data-inline={props.inline ? "" : undefined}>
    <For each={props.items}>
      {(item) => (
        <>
          <dt>{item.label}</dt>
          <dd data-wide={!props.inline && !item.copy ? "" : undefined}>
            {item.value}
            <Show when={item.hint}>
              <small>{item.hint}</small>
            </Show>
          </dd>
          <Show when={!props.inline && item.copy}>{(value) => <CopyButton label={item.label} value={value()} />}</Show>
        </>
      )}
    </For>
    <Show when={props.inline && props.end}>
      <span class="k2-facts-end">{props.end}</span>
    </Show>
  </dl>
);

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

/** One entry: from column edge to column edge, square, also when it opens something. */
export const Row = (props: RowProps) => {
  const inList = useContext(ListContext);
  const rest = props;
  const lines = () => rest.lines.length;
  return (
    <Dynamic
      component={rest.href ? "a" : rest.onOpen ? "button" : "div"}
      href={rest.href}
      type={rest.onOpen && !rest.href ? "button" : undefined}
      onClick={rest.onOpen}
      class="k2-row"
      data-k2-part="Row"
      role={inList ? "listitem" : undefined}
      data-open={rest.href || rest.onOpen ? "" : undefined}
      data-lines={String(lines())}
      data-unread={rest.unread ? "" : undefined}
      data-strong={rest.strong ? "" : undefined}
      data-selected={rest.selected ? "" : undefined}
      aria-current={rest.selected ? "true" : undefined}
      data-yours={rest.yours ? "" : undefined}
      data-avatar={rest.avatar ? "" : undefined}
      data-time={rest.time !== undefined ? "" : undefined}
      data-action={rest.action ? "" : undefined}
      style={custom({ "--k2-c": rest.color })}
    >
      <>
        <span class="k2-row-lead">
          <Show
            when={rest.avatar}
            fallback={
              <Show
                when={rest.icon}
                fallback={
                  <Show when={rest.unread}>
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
          <span class="k2-row-title">{rest.lines[0]}</span>
          <Show when={rest.meta !== undefined}>
            <span class="k2-row-meta">{rest.meta}</span>
          </Show>
        </span>
        <Show when={lines() > 1}>
          <span class="k2-row-l2">{rest.lines[1]}</span>
        </Show>
        <Show when={lines() > 2}>
          <span class="k2-row-l3">{rest.lines[2]}</span>
        </Show>
        <Show when={rest.time !== undefined}>
          <span class="k2-row-time">{rest.time}</span>
        </Show>
        <Show when={rest.end !== undefined || rest.action}>
          <span class="k2-row-end">
            <Show when={rest.action}>{(action) => <ActionButton action={action()} />}</Show>
            {rest.end}
          </span>
        </Show>
        <Show when={rest.marks !== undefined}>
          <span class="k2-row-marks">{rest.marks}</span>
        </Show>
      </>
    </Dynamic>
  );
};

// ── Table ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** What a cell shows: one line, or a line and a quiet second line. */
export type CellValue = JSX.Element | readonly [JSX.Element, JSX.Element];

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

export type TableProps<T> = {
  columns: readonly Column<T>[];
  rows: readonly T[];
  /** A name for the table, for assistive technology. */
  label?: string;
  /** The stable key of a row; needed for `select`, `current` and `group`. */
  rowKey?: (row: T) => string;
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
  /** The first column (and the box column) stays while the table scrolls sideways; an edge shows behind it. */
  sticky?: boolean;
  /** Rows of a group follow one another under a tinted group row of 36 px (no frame: it would cut the columns). */
  group?: (row: T) => { key: string; head: JSX.Element; meta?: string };
  /** The column the rows are sorted by: an arrow in its head. */
  sort?: { column: number; direction: "ascending" | "descending" };
  /** On the phone each row becomes a row of two lines instead (rule 7). */
  phone?: (row: T) => { lines: readonly [JSX.Element, JSX.Element]; avatar?: Person; time?: JSX.Element };
};

const isPair = (value: CellValue): value is readonly [JSX.Element, JSX.Element] => Array.isArray(value) && value.length === 2;

type TableItem<T> = { group: { key: string; head: JSX.Element; meta?: string } } | { row: T };

/**
 * Many like things in columns: head 36, a line under every row, none between columns. Long text stays on one line
 * with "…" and a fixed row height (variant a, decided 22.11.); `wrap` lets one text column take three lines. With
 * `select` or `sticky` it is the large table of Grids: one scroller for head and rows, a sticky head and first column,
 * rows and cells under the pointer, groups as tinted rows.
 */
export const Table = <T,>(props: TableProps<T>) => {
  const grid = () => props.select !== undefined || props.sticky === true;
  const sized = () => grid() || props.columns.some((column) => column.width);
  const lines = () => (props.rows.some((row) => props.columns.some((column) => isPair(column.cell(row)))) ? "2" : "1");
  const key = (row: T, index: number) => props.rowKey?.(row) ?? String(index);
  const items = (): TableItem<T>[] => {
    const out: TableItem<T>[] = [];
    let last: string | undefined;
    for (const row of props.rows) {
      const group = props.group?.(row);
      if (group && group.key !== last) out.push({ group });
      last = group?.key;
      out.push({ row });
    }
    return out;
  };
  const selected = (row: T, index: number) => props.select?.selected.includes(key(row, index)) ?? false;
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

  const cell = (column: Column<T>, row: T) => {
    const value = column.cell(row);
    // Every line of a cell is a block of its own: cut with "…" in a sized table, wrapped in a small one.
    const line = (content: JSX.Element, second = false) => (
      <span class="k2-cell-line" data-wrap={!second && column.wrap ? "" : undefined} data-second={second ? "" : undefined}>
        {content}
      </span>
    );
    return isPair(value) ? [line(value[0]), line(value[1], true)] : line(value as JSX.Element);
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
              {(item, index) =>
                "group" in item ? (
                  <tr data-group="">
                    <td colSpan={span()}>
                      <span class="k2-group-row">
                        {item.group.head}
                        <Show when={item.group.meta}>
                          <span class="k2-group-row-meta">{item.group.meta}</span>
                        </Show>
                      </span>
                    </td>
                  </tr>
                ) : (
                  <tr
                    aria-selected={props.select ? (selected(item.row, index()) ? "true" : "false") : undefined}
                    aria-current={props.current !== undefined && props.current === key(item.row, index()) ? "true" : undefined}
                  >
                    <Show when={props.select}>
                      {(select) => (
                        <td data-select="" data-sticky={props.sticky ? "" : undefined}>
                          <MarkCheck
                            label={select().row(item.row)}
                            checked={selected(item.row, index())}
                            onChange={(on) => toggle(key(item.row, index()), on)}
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
                          {cell(column, item.row)}
                        </td>
                      )}
                    </For>
                  </tr>
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
                        {item.group.head}
                        <Show when={item.group.meta}>
                          <span class="k2-t-meta">{item.group.meta}</span>
                        </Show>
                      </div>
                    </div>
                  ) : (
                    (() => {
                      const form = phone()(item.row);
                      return <Row lines={form.lines} avatar={form.avatar} time={form.time} strong />;
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
