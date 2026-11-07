import {
  type Accessor,
  createContext,
  createEffect,
  createMemo,
  createSignal,
  createUniqueId,
  For,
  type JSX,
  Match,
  on,
  onCleanup,
  onMount,
  Show,
  Switch,
  useContext,
} from "solid-js";
import { Dynamic } from "solid-js/web";
import { announce } from "../feedback/announce";
import { suppressTextSelection } from "../internal/text-selection";
import { useLocale } from "../intl/locale";
import { useUiMessages } from "../intl/messages";
import { PanelHeader } from "../layout/PanelHeader";
import { DeltaBadge } from "../surfaces/delta-badge";
import { Paper } from "../surfaces/Paper";
import Placeholder from "../surfaces/Placeholder";
import { StatusBadge } from "../surfaces/StatusBadge";
import type { CollectionSelection } from "./collection-selection";
import {
  type DataTableTypedColumn,
  formatTableNumber,
  groupRows,
  isEmptyCell,
  isNumericColumnType,
  readTableValue,
  tableCellText,
} from "./data-table-columns";
import { useDataTableMessages } from "./data-table-messages";
import { FlowAmount } from "./FlowAmount";

export type DataTableColumn<T> = {
  id: string;
  header: JSX.Element | ((ctx: { col: DataTableColumn<T> }) => JSX.Element);
  subtitle?: JSX.Element | ((ctx: { col: DataTableColumn<T> }) => JSX.Element);
  value?: keyof T | ((row: T) => unknown);
  class?: string;
  headerClass?: string;
  cellClass?: string;
  /** Defaults to right for numeric values and left for everything else. */
  align?: "left" | "center" | "right";
  /**
   * Keeps each value on one line, so the column is at least as wide as its
   * longest value. For dates, times, numbers, amounts, and short codes.
   * Defaults to true when the column's first value is a number or date. The
   * default cell wrapper already keeps every value on one line; this option
   * decides wrapping for content under a custom `cellContentClass`, and a
   * `white-space` that class sets itself wins.
   */
  nowrap?: boolean;
  /**
   * Marks the column sortable. Pass a string when the server's sort key
   * differs from the column id — they often do, because one column can show a
   * rate while another sorts by the absolute count behind it.
   */
  sortable?: boolean | string;
  /** What the column holds; see `DataTableColumnType`. */
  type?: DataTableTypedColumn["type"];
  format?: DataTableTypedColumn["format"];
  /** Labels and tones of a status column, by stored value. */
  states?: DataTableTypedColumn["states"];
  /** The value a bar column fills its track at; defaults to its largest value. */
  max?: number;
  /** The zone a date column with a time reads in; defaults to the reader's. */
  timeZone?: string;
  /** How a delta column reads and rates its change. */
  delta?: DataTableTypedColumn["delta"];
  /**
   * How much a narrow table needs the column: 1 (default) always shows; 3 hides below a table width of 560 px,
   * 2 below 420 px. Hidden values stay one tap away in the row's details.
   */
  priority?: 1 | 2 | 3;
};

export type DataTableSort = { key: string; direction: "asc" | "desc" };

export type DataTableRenderCell<T> = (ctx: {
  row: T;
  col: DataTableColumn<T>;
  value: unknown;
  render: (value: unknown) => JSX.Element;
}) => JSX.Element;

export type DataTableRenderHeader<T> = (ctx: { col: DataTableColumn<T>; render: () => JSX.Element }) => JSX.Element;

export type DataTableFooter<T> = {
  values?: Record<string, unknown>;
  renderCell?: (ctx: { col: DataTableColumn<T>; value: unknown; render: (value: unknown) => JSX.Element }) => JSX.Element;
};

export type DataTableProps<T> = {
  rows: readonly T[];
  columns: readonly DataTableColumn<T>[];
  /** Accessible name for a standalone table region. Defaults to "Data table". */
  ariaLabel?: string;
  /** ID of a visible heading that labels the table region. Takes precedence over ariaLabel. */
  ariaLabelledBy?: string;
  getRowId?: (row: T) => string;
  /** Current server-side ordering, or null when the default applies. */
  sort?: DataTableSort | null;
  /**
   * Link target for a sortable header. Link-based because every admin table is
   * server-rendered: sorting is a query change, not client state.
   */
  sortHref?: (next: DataTableSort) => string;
  /**
   * Sorts on the client instead: sortable headers become buttons that report the
   * next order, with the same look and order of directions as `sortHref`.
   */
  onSortChange?: (next: DataTableSort) => void;
  selectedRowId?: string | null;
  /** Optional multi-selection shared with another collection view. Requires getRowId. */
  selection?: CollectionSelection;
  rowClass?: string | ((row: T) => string | undefined);
  hoverRows?: boolean;
  onRowClick?: (row: T) => void;
  onRowDoubleClick?: (row: T) => void;
  onRowContextMenu?: (row: T) => void;
  renderCell?: DataTableRenderCell<T>;
  renderHeader?: DataTableRenderHeader<T>;
  footer?: DataTableFooter<T>;
  hasMore?: boolean;
  loadingMore?: boolean;
  loading?: boolean;
  /** Initial placeholder count, clamped to an integer from 1 to 50. Defaults to 5. */
  loadingRows?: number;
  onLoadMore?: () => void;
  empty?: JSX.Element;
  density?: "compact" | "normal";
  stickyHeader?: boolean;
  highlightColumns?: boolean;
  verticalAlign?: "top" | "middle" | "bottom";
  cellContentClass?: string;
  fillHeight?: boolean;
  /** Visual frame for a standalone table. Defaults preserve the legacy class-based behavior. */
  surface?: "paper" | "plain";
  class?: string;
  /** Additional classes for the table element. Core table geometry is always retained. */
  tableClass?: string;
  /** Additional classes for the scrolling region, such as `k2b-detail-trail`. */
  scrollClass?: string;
  scrollPreserveKey?: string | false;
  /**
   * The id of the column whose values split the rows into groups, each its own `<tbody>` under a row with the
   * group's value and count, in the order the groups first appear.
   */
  groupBy?: string;
  /**
   * The host's search text. With no rows left, the table says that nothing matches it and offers to clear it
   * through `onClearQuery`, instead of `empty`. Filter the rows with `filterRows`.
   */
  query?: string;
  onClearQuery?: () => void;
};

export type DataTablePanelProps = {
  children: JSX.Element;
  class?: string;
};

export type DataTableHeaderProps = {
  title: string;
  subtitle?: string;
  children?: JSX.Element;
  as?: "h1" | "h2" | "h3";
  size?: "sm" | "md";
  class?: string;
};

export type DataTableControlsProps = {
  children: JSX.Element;
  class?: string;
};

export type DataTablePanelFooterProps = {
  children: JSX.Element;
  class?: string;
};

type DataTablePanelContextValue = {
  headingId: string;
  hasHeading: Accessor<boolean>;
  registerHeading: () => void;
};

const DataTablePanelContext = createContext<DataTablePanelContextValue>();

const defaultRender = (
  value: unknown,
  locale: string,
  numbers: Intl.NumberFormat,
  messages: ReturnType<ReturnType<typeof useUiMessages>>,
): JSX.Element => {
  if (value === null || value === undefined || value === "") return "—";
  if (value instanceof Date) return value.toLocaleString(locale);
  if (typeof value === "boolean") return value ? messages.yes : messages.no;
  // Numbers read in the reader's language: grouping and decimal mark follow the locale, at most three decimals.
  if (typeof value === "number" || typeof value === "bigint") return numbers.format(Object.is(value, -0) ? 0 : value);
  if (typeof value === "string") return value;
  return JSON.stringify(value);
};

const renderColumnPart = <T,>(
  part: DataTableColumn<T>["header"] | DataTableColumn<T>["subtitle"],
  col: DataTableColumn<T>,
): JSX.Element => {
  if (typeof part === "function") return part({ col });
  return part;
};

const rowInteractiveSelector = [
  "a[href]",
  "button",
  "input",
  "label",
  "select",
  "textarea",
  "summary",
  "[contenteditable]",
  "[role='button']",
  "[role='checkbox']",
  "[role='link']",
  "[role='menuitem']",
  "[role='option']",
  "[role='radio']",
  "[role='switch']",
  "[role='tab']",
  "[tabindex]",
].join(",");

const isNestedRowControl = (event: Event): boolean =>
  event.target instanceof Element && event.target.closest(rowInteractiveSelector) !== event.currentTarget;

/** Distance in pixels before the table's end at which the next page is requested. */
const loadMoreMargin = 240;

type DataTableScrollbarAxis = "x" | "y";
type DataTableScrollbarMetrics = { overflow: boolean; offset: number; size: number };

const scrollbarMetrics = (viewportSize: number, contentSize: number, scrollOffset: number): DataTableScrollbarMetrics => {
  if (viewportSize <= 0 || contentSize <= viewportSize + 1) return { overflow: false, offset: 0, size: 0 };
  const size = Math.min(viewportSize, Math.max(24, (viewportSize * viewportSize) / contentSize));
  const offset = (scrollOffset / (contentSize - viewportSize)) * (viewportSize - size);
  return { overflow: true, offset, size };
};

function DataTableRoot<T>(props: DataTableProps<T>) {
  const messages = useUiMessages();
  const dataTableMessages = useDataTableMessages();
  const locale = useLocale();
  const [hoveredColumn, setHoveredColumn] = createSignal<number | null>(null);
  const [scrollbars, setScrollbars] = createSignal<Record<DataTableScrollbarAxis, DataTableScrollbarMetrics>>({
    x: { overflow: false, offset: 0, size: 0 },
    y: { overflow: false, offset: 0, size: 0 },
  });
  const [scrollbarEnhanced, setScrollbarEnhanced] = createSignal(false);
  const [scrolling, setScrolling] = createSignal(false);
  const panel = useContext(DataTablePanelContext);
  let tableRef: HTMLTableElement | undefined;
  let scrollRef: HTMLDivElement | undefined;
  let loadMoreRef: HTMLDivElement | undefined;
  let scrollingTimeout: ReturnType<typeof setTimeout> | undefined;
  let scrollbarDragOffset = 0;
  let hasMore = false;
  let loadingMore = false;
  let onLoadMore: (() => void) | undefined;
  let loadMoreRequested = false;
  let previousRowsLength = props.rows.length;
  let previousLoadingMore = !!props.loadingMore;
  let previousHasMore = !!props.hasMore;
  const loadingRows = () => Math.min(50, Math.max(1, Math.trunc(Number.isNaN(props.loadingRows) ? 5 : (props.loadingRows ?? 5))));
  const rowId = (row: T) => props.getRowId?.(row);
  const isInteractive = () => !!props.selection || !!props.onRowClick || !!props.onRowDoubleClick;
  const shouldHoverRows = () => props.hoverRows ?? isInteractive();
  const shouldRenderLoadMoreSentinel = () => !!props.onLoadMore;
  const labelledBy = () => props.ariaLabelledBy ?? (panel?.hasHeading() ? panel.headingId : undefined);
  const surface = () => props.surface ?? (props.class ? "plain" : "paper");
  const cellContentClass = () => props.cellContentClass ?? "k2b-data-table__cell-text";
  const tableClass = () => `k2b-data-table ${props.tableClass ?? ""}`.trim();
  const columnHighlighted = (index: number) =>
    props.highlightColumns !== false && shouldHoverRows() && hoveredColumn() === index ? "true" : undefined;
  const setHoveredColumnIfEnabled = (index: number) => {
    if (shouldHoverRows()) setHoveredColumn(index);
  };

  /**
   * A bounded table scrolls its own viewport. A table that grows with its rows
   * leaves scrolling to the page or an ancestor, so its end is measured against
   * the browser viewport instead.
   */
  const isNearBottom = () => {
    if (!scrollRef || !loadMoreRef) return false;
    if (scrollRef.scrollHeight > scrollRef.clientHeight + 1) {
      return scrollRef.scrollTop + scrollRef.clientHeight >= scrollRef.scrollHeight - loadMoreMargin;
    }
    return loadMoreRef.getBoundingClientRect().top <= window.innerHeight + loadMoreMargin;
  };

  const maybeLoadMore = () => {
    if (!hasMore || loadingMore || !onLoadMore) return;
    if (!isNearBottom()) {
      // Leaving the end re-arms a request the owner declined, for example while its first page was still loading.
      loadMoreRequested = false;
      return;
    }
    if (loadMoreRequested) return;
    loadMoreRequested = true;
    try {
      onLoadMore();
    } catch (error) {
      loadMoreRequested = false;
      throw error;
    }
  };

  const syncScrollbars = () => {
    if (!scrollRef) return;
    setScrollbars({
      x: scrollbarMetrics(scrollRef.clientWidth, scrollRef.scrollWidth, scrollRef.scrollLeft),
      y: scrollbarMetrics(scrollRef.clientHeight, scrollRef.scrollHeight, scrollRef.scrollTop),
    });
  };

  const revealScrollbars = () => {
    setScrolling(true);
    if (scrollingTimeout !== undefined) clearTimeout(scrollingTimeout);
    scrollingTimeout = setTimeout(() => {
      setScrolling(false);
      scrollingTimeout = undefined;
    }, 700);
  };

  const onScroll = () => {
    syncScrollbars();
    revealScrollbars();
    maybeLoadMore();
  };

  const scrollFromPointer = (event: PointerEvent & { currentTarget: HTMLDivElement }, axis: DataTableScrollbarAxis) => {
    if (!scrollRef) return;
    const track = event.currentTarget;
    const metrics = scrollbars()[axis];
    const rect = track.getBoundingClientRect();
    const trackSize = axis === "y" ? rect.height : rect.width;
    const pointerOffset = axis === "y" ? event.clientY - rect.top : event.clientX - rect.left;
    const available = Math.max(1, trackSize - metrics.size);
    const thumbOffset = Math.min(available, Math.max(0, pointerOffset - scrollbarDragOffset));
    const maxScroll = axis === "y" ? scrollRef.scrollHeight - scrollRef.clientHeight : scrollRef.scrollWidth - scrollRef.clientWidth;
    if (axis === "y") scrollRef.scrollTop = (thumbOffset / available) * maxScroll;
    else scrollRef.scrollLeft = (thumbOffset / available) * maxScroll;
    syncScrollbars();
    revealScrollbars();
  };

  const startScrollbarDrag = (event: PointerEvent & { currentTarget: HTMLDivElement }, axis: DataTableScrollbarAxis) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const metrics = scrollbars()[axis];
    const rect = event.currentTarget.getBoundingClientRect();
    const pointerOffset = axis === "y" ? event.clientY - rect.top : event.clientX - rect.left;
    scrollbarDragOffset =
      event.target === event.currentTarget ? metrics.size / 2 : Math.min(metrics.size, Math.max(0, pointerOffset - metrics.offset));
    event.currentTarget.setPointerCapture(event.pointerId);
    // The track's own pointerup or pointercancel ends the hold.
    suppressTextSelection(event.pointerId);
    scrollFromPointer(event, axis);
  };

  const valueOf = (row: T, col: DataTableColumn<T>) => readTableValue(row, col);

  const columnPresentation = createMemo(() => {
    const presentation = new Map<string, { align: NonNullable<DataTableColumn<T>["align"]>; nowrap: boolean }>();
    for (const col of props.columns) {
      // A typed column says what it holds; only an untyped one is read from its first value.
      let numeric = isNumericColumnType(col.type);
      let date = col.type === "date";
      if (!col.type && (col.align === undefined || col.nowrap === undefined)) {
        for (const row of props.rows) {
          const value = valueOf(row, col);
          if (value === null || value === undefined || value === "") continue;
          numeric = typeof value === "number" || typeof value === "bigint";
          date = value instanceof Date;
          break;
        }
      }
      presentation.set(col.id, { align: col.align ?? (numeric ? "right" : "left"), nowrap: col.nowrap ?? (numeric || date) });
    }
    return presentation;
  });

  /** `data-align` mirrors Cloud's `text-left/center/right` on the same cell. */
  const alignAttr = (col: DataTableColumn<T>) => {
    const align = columnPresentation().get(col.id)?.align ?? "left";
    return align === "left" ? undefined : align;
  };

  const nowrapAttr = (col: DataTableColumn<T>) => (columnPresentation().get(col.id)?.nowrap ? "true" : undefined);
  /** Text columns wrap inside their cell; every other value keeps one line. */
  const wrapAttr = (col: DataTableColumn<T>) => (col.type === "text" && col.nowrap !== true ? "true" : undefined);
  const priorityAttr = (col: DataTableColumn<T>) => (col.priority === 2 || col.priority === 3 ? String(col.priority) : undefined);
  /** The lowest priority present: 3 shows the details toggle below 560 px, 2 below 420 px. */
  const detailsPriority = createMemo(() => {
    const priorities = props.columns.map((col) => col.priority ?? 1);
    return priorities.includes(3) ? "3" : priorities.includes(2) ? "2" : undefined;
  });
  const hiddenColumns = () => props.columns.filter((col) => priorityAttr(col));
  const columnCount = () => props.columns.length + (detailsPriority() ? 1 : 0);
  const [openDetails, setOpenDetails] = createSignal<ReadonlySet<T>>(new Set());
  const toggleDetails = (row: T) =>
    setOpenDetails((open) => {
      const next = new Set(open);
      if (!next.delete(row)) next.add(row);
      return next;
    });
  /** A bar column fills its track at `max`, or else at its largest value. */
  const barMax = createMemo(() => {
    const max = new Map<string, number>();
    for (const col of props.columns) {
      if (col.type !== "bar") continue;
      if (col.max !== undefined && col.max > 0) {
        max.set(col.id, col.max);
        continue;
      }
      let largest = 0;
      for (const row of props.rows) {
        const value = Number(valueOf(row, col));
        if (Number.isFinite(value)) largest = Math.max(largest, Math.abs(value));
      }
      max.set(col.id, largest);
    }
    return max;
  });
  const groups = createMemo(() => {
    const col = props.groupBy ? props.columns.find((entry) => entry.id === props.groupBy) : undefined;
    return col ? groupRows(props.rows, col, locale()) : null;
  });

  const sortKeyOf = (col: DataTableColumn<T>): string | null =>
    col.sortable === true ? col.id : typeof col.sortable === "string" ? col.sortable : null;

  /**
   * Sorting is a link by default: server-rendered tables keep the order in the
   * URL. Client tables pass onSortChange instead. Clicking the active column
   * flips its direction.
   */
  const nextSortFor = (key: string): DataTableSort => ({
    key,
    direction: props.sort?.key === key && props.sort?.direction === "desc" ? "asc" : "desc",
  });

  /** Only a sortable column carries a sort state; the rest carry none at all. */
  const ariaSortFor = (col: DataTableColumn<T>): "ascending" | "descending" | "none" | undefined => {
    const key = sortKeyOf(col);
    if (!key || (!props.sortHref && !props.onSortChange && !props.renderHeader)) return undefined;
    if (props.sort?.key !== key) return "none";
    return props.sort?.direction === "asc" ? "ascending" : "descending";
  };

  const renderHeaderDefault = (col: DataTableColumn<T>): JSX.Element => {
    const key = sortKeyOf(col);
    // Only how a column sorts decides the element. The order lives in its attributes, so a header button keeps
    // keyboard focus when a click sorts the table and the reader can press it again to reverse the order.
    const mode = createMemo(() => (!key ? null : props.sortHref ? "link" : props.onSortChange ? "button" : null));
    const active = () => key !== null && props.sort?.key === key;
    const title = () => (
      <>
        <span class="k2b-data-table__header-title">{renderColumnPart(col.header, col)}</span>
        <Show when={col.subtitle !== undefined}>
          <span class="k2b-data-table__header-subtitle">{renderColumnPart(col.subtitle, col)}</span>
        </Show>
      </>
    );
    const line = () => (
      <span class="k2b-data-table__header-line">
        {title()}
        {/* Inactive columns keep a dimmed marker so the row reads as sortable. */}
        <i
          class={`k2b-data-table__sort-icon ti ${active() && props.sort?.direction === "asc" ? "ti-arrow-up" : "ti-arrow-down"}`}
          data-active={active() ? "true" : undefined}
          aria-hidden="true"
        />
      </span>
    );

    return (
      <Switch
        fallback={
          <div class="k2b-data-table__header-content" data-align={alignAttr(col)}>
            {title()}
          </div>
        }
      >
        <Match when={mode() === "link"}>
          <a
            href={key ? props.sortHref?.(nextSortFor(key)) : undefined}
            class="k2b-data-table__header-content k2b-data-table__sort"
            data-align={alignAttr(col)}
          >
            {line()}
          </a>
        </Match>
        <Match when={mode() === "button"}>
          <button
            type="button"
            class="k2b-data-table__header-content k2b-data-table__sort"
            data-align={alignAttr(col)}
            onClick={() => key && props.onSortChange?.(nextSortFor(key))}
          >
            {line()}
          </button>
        </Match>
      </Switch>
    );
  };

  const numberFormat = createMemo(() => new Intl.NumberFormat(locale()));
  const renderValueDefault = (value: unknown) => defaultRender(value, locale(), numberFormat(), messages());
  /** A typed column shows its value the way its type reads; an untyped one falls back to the plain rendering. */
  const renderTypedValue = (col: DataTableColumn<T>, value: unknown): JSX.Element => {
    if (!col.type || isEmptyCell(value)) return renderValueDefault(value);
    if (col.type === "status") {
      const state = col.states?.[String(value)];
      return state ? <StatusBadge tone={state.tone} label={state.label} variant="dot" /> : String(value);
    }
    if (col.type === "flow" && col.format?.currency && Number.isFinite(Number(value)))
      return <FlowAmount value={Number(value)} currency={col.format.currency} decimals={col.format.decimals} />;
    if (col.type === "delta" && Number.isFinite(Number(value)))
      return <DeltaBadge delta={{ value: Number(value), unit: col.delta?.unit, better: col.delta?.better }} />;
    if (col.type === "bar") {
      const number = Number(value);
      const max = barMax().get(col.id) ?? 0;
      if (!Number.isFinite(number)) return String(value);
      return (
        <span class="k2b-data-table__bar">
          {formatTableNumber(number, col, locale())}
          <span class="k2b-data-table__bar-track" aria-hidden="true">
            <span style={{ width: `${max > 0 ? Math.min(100, (Math.abs(number) / max) * 100) : 0}%` }} />
          </span>
        </span>
      );
    }
    return tableCellText(value, col, locale());
  };

  const onRowKeyDown = (event: KeyboardEvent, row: T) => {
    if (!isInteractive()) return;
    if (isNestedRowControl(event)) return;
    const id = rowId(row);
    if (id !== undefined && props.selection?.keyDown(event, id)) return;
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    (props.selection ? props.onRowDoubleClick : (props.onRowClick ?? props.onRowDoubleClick))?.(row);
  };

  const onRowClick = (event: MouseEvent, row: T) => {
    if (isNestedRowControl(event)) return;
    const id = rowId(row);
    if (id !== undefined) props.selection?.select(id, event);
    props.onRowClick?.(row);
  };

  const onRowDoubleClick = (event: MouseEvent, row: T) => {
    if (isNestedRowControl(event)) return;
    props.onRowDoubleClick?.(row);
  };

  const rowClass = (row: T) => {
    if (typeof props.rowClass === "function") return props.rowClass(row) ?? "";
    return props.rowClass ?? "";
  };

  // A heading given as a JSX node lives in the head; each details line needs its own copy, so it takes text or a fresh call.
  const detailLabel = (col: DataTableColumn<T>) =>
    typeof col.header === "function"
      ? col.header({ col })
      : typeof col.header === "string" || typeof col.header === "number"
        ? col.header
        : col.id;
  const cellContent = (row: T, col: DataTableColumn<T>, value: unknown) =>
    props.renderCell ? props.renderCell({ row, col, value, render: (v) => renderTypedValue(col, v) }) : renderTypedValue(col, value);

  /** `last` marks the final row of its body when details rows follow every row, so the frame keeps the only edge. */
  const renderRow = (row: T, last: () => boolean) => {
    const id = () => rowId(row);
    const isSelected = () =>
      props.selection ? props.selection.selected().has(id() ?? "") : props.selectedRowId && id() === props.selectedRowId;
    const detailsId = `k2b-data-table-${createUniqueId()}-details`;
    const open = () => openDetails().has(row);
    return (
      <>
        <tr
          ref={(element) => {
            const key = id();
            if (key !== undefined) props.selection?.register(key, element);
          }}
          class={`k2b-data-table__row ${rowClass(row)}`}
          data-hover={shouldHoverRows() ? "true" : undefined}
          data-clickable={shouldHoverRows() && isInteractive() ? "true" : undefined}
          data-selected={isSelected() ? "true" : undefined}
          data-details-open={open() ? "true" : undefined}
          data-last={detailsPriority() && last() ? "true" : undefined}
          aria-selected={props.selection ? !!isSelected() : undefined}
          tabIndex={props.selection ? (props.selection.focused() === id() ? 0 : -1) : isInteractive() ? 0 : undefined}
          onFocus={() => {
            const key = id();
            if (key !== undefined) props.selection?.markFocused(key);
          }}
          onClick={(event) => onRowClick(event, row)}
          onDblClick={(event) => onRowDoubleClick(event, row)}
          onContextMenu={() => props.onRowContextMenu?.(row)}
          onKeyDown={(e) => onRowKeyDown(e, row)}
        >
          <For each={props.columns}>
            {(col, index) => {
              const value = () => valueOf(row, col);
              return (
                <td
                  class={`${col.cellClass ?? ""} ${col.class ?? ""}`}
                  data-nowrap={nowrapAttr(col)}
                  data-wrap={wrapAttr(col)}
                  data-align={alignAttr(col)}
                  data-priority={priorityAttr(col)}
                  data-valign={props.verticalAlign && props.verticalAlign !== "middle" ? props.verticalAlign : undefined}
                  data-highlighted={columnHighlighted(index())}
                  onMouseEnter={() => setHoveredColumnIfEnabled(index())}
                >
                  <div class={cellContentClass()}>{cellContent(row, col, value())}</div>
                </td>
              );
            }}
          </For>
          <Show when={detailsPriority()}>
            <td class="k2b-data-table__details-toggle">
              <button
                type="button"
                class="k2b-data-table__details-button"
                aria-expanded={open()}
                aria-controls={detailsId}
                aria-label={dataTableMessages().showDetails}
                onClick={() => toggleDetails(row)}
              >
                <i class={`ti ${open() ? "ti-chevron-up" : "ti-chevron-down"}`} aria-hidden="true" />
              </button>
            </td>
          </Show>
        </tr>
        <Show when={detailsPriority()}>
          {/* Only the values the table's width hides appear here; the rest are in the row above. */}
          <tr class="k2b-data-table__details" id={detailsId} hidden={!open()}>
            <td colspan={columnCount()}>
              <dl>
                <For each={hiddenColumns()}>
                  {(col) => (
                    <div data-priority={priorityAttr(col)}>
                      <dt>{detailLabel(col)}</dt>
                      <dd>{cellContent(row, col, valueOf(row, col))}</dd>
                    </div>
                  )}
                </For>
              </dl>
            </td>
          </tr>
        </Show>
      </>
    );
  };

  onMount(() => {
    if (typeof IntersectionObserver === "undefined" || !loadMoreRef) return;
    // The viewport root notices the end whichever element scrolls; `isNearBottom` decides.
    const observer = new IntersectionObserver(maybeLoadMore, { rootMargin: `${loadMoreMargin}px` });
    observer.observe(loadMoreRef);
    onCleanup(() => observer.disconnect());
  });

  onMount(() => {
    setScrollbarEnhanced(true);
    syncScrollbars();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(syncScrollbars);
    if (scrollRef) observer?.observe(scrollRef);
    if (tableRef) observer?.observe(tableRef);
    onCleanup(() => {
      observer?.disconnect();
      if (scrollingTimeout !== undefined) clearTimeout(scrollingTimeout);
    });
  });

  // Announced once per wait, outside the region that `aria-busy` keeps quiet.
  createEffect(
    on(
      () => !!props.loading && props.rows.length === 0,
      (waiting) => {
        if (waiting) announce(dataTableMessages().loadingRows);
      },
    ),
  );

  createEffect(() => {
    const rowsLength = props.rows.length;
    const nextHasMore = !!props.hasMore;
    const nextLoadingMore = !!props.loadingMore;
    if (rowsLength !== previousRowsLength || (previousLoadingMore && !nextLoadingMore) || (!previousHasMore && nextHasMore)) {
      loadMoreRequested = false;
    }
    previousRowsLength = rowsLength;
    previousLoadingMore = nextLoadingMore;
    previousHasMore = nextHasMore;
    hasMore = nextHasMore;
    loadingMore = nextLoadingMore;
    onLoadMore = props.onLoadMore;
    maybeLoadMore();
    queueMicrotask(syncScrollbars);
  });

  return (
    <Show when={props.columns.length > 0} fallback={<Placeholder surface="paper" description={<>{dataTableMessages().noColumns}</>} />}>
      <Dynamic
        component={surface() === "paper" ? Paper : "div"}
        class={`k2b-table-shell ${props.class ?? ""}`}
        data-surface={surface()}
        data-has-footer={props.footer ? "true" : undefined}
        data-priorities={detailsPriority()}
        data-overflow-x={scrollbars().x.overflow ? "true" : undefined}
        data-overflow-y={scrollbars().y.overflow ? "true" : undefined}
        data-scrollbar-enhanced={scrollbarEnhanced() ? "true" : undefined}
        data-scrolling={scrolling() ? "true" : undefined}
        onMouseLeave={() => setHoveredColumn(null)}
      >
        <div
          ref={scrollRef}
          role="region"
          aria-label={labelledBy() ? undefined : (props.ariaLabel ?? dataTableMessages().dataTable)}
          aria-labelledby={labelledBy()}
          aria-busy={props.loading ? "true" : undefined}
          tabIndex={0}
          class={`k2b-table-wrap${props.scrollClass ? ` ${props.scrollClass}` : ""}`}
          data-density={props.density === "compact" ? "compact" : undefined}
          data-has-footer={props.footer ? "true" : undefined}
          data-surface={surface()}
          data-scroll-preserve={props.scrollPreserveKey || undefined}
          onScroll={onScroll}
        >
          <table ref={tableRef} class={tableClass()} data-fill={props.fillHeight ? "true" : undefined}>
            <Show when={props.loading}>
              {/* Names the table while it waits; the announcement goes through the shared live region outside the busy region. */}
              <caption class="k2b-sr-only">{dataTableMessages().loadingRows}</caption>
            </Show>
            <thead class="k2b-data-table__head" data-sticky={props.stickyHeader === false ? undefined : "true"}>
              <tr class="k2b-data-table__head-row">
                <For each={props.columns}>
                  {(col, index) => (
                    <th
                      scope="col"
                      class={`${col.headerClass ?? ""} ${col.class ?? ""}`}
                      data-align={alignAttr(col)}
                      data-priority={priorityAttr(col)}
                      data-highlighted={columnHighlighted(index())}
                      aria-sort={ariaSortFor(col)}
                      onMouseEnter={() => setHoveredColumnIfEnabled(index())}
                    >
                      {props.renderHeader ? props.renderHeader({ col, render: () => renderHeaderDefault(col) }) : renderHeaderDefault(col)}
                    </th>
                  )}
                </For>
                <Show when={detailsPriority()}>
                  <th scope="col" class="k2b-data-table__details-toggle">
                    <span class="k2b-sr-only">{dataTableMessages().details}</span>
                  </th>
                </Show>
              </tr>
            </thead>
            <Show
              when={props.rows.length > 0}
              fallback={
                <tbody>
                  <Show
                    when={props.loading}
                    fallback={
                      <tr>
                        <Show
                          when={props.query?.trim()}
                          fallback={
                            <td class="k2b-data-table__empty" colspan={columnCount()}>
                              <Placeholder description={<>{props.empty ?? dataTableMessages().noRecords}</>} />
                            </td>
                          }
                        >
                          {(query) => (
                            <td class="k2b-data-table__no-match" colspan={columnCount()}>
                              {dataTableMessages().noMatch({ query: query() })}{" "}
                              <Show when={props.onClearQuery}>
                                <button type="button" class="k2b-data-table__clear-query" onClick={() => props.onClearQuery?.()}>
                                  {dataTableMessages().clearSearch}
                                </button>
                              </Show>
                            </td>
                          )}
                        </Show>
                      </tr>
                    }
                  >
                    <For each={Array.from({ length: loadingRows() })}>
                      {() => (
                        <tr class="k2b-data-table__row" data-loading="true" aria-hidden="true">
                          <For each={props.columns}>
                            {(col) => (
                              <td data-align={alignAttr(col)} data-priority={priorityAttr(col)}>
                                <span class="k2b-data-table__skeleton" />
                              </td>
                            )}
                          </For>
                          <Show when={detailsPriority()}>
                            <td class="k2b-data-table__details-toggle" />
                          </Show>
                        </tr>
                      )}
                    </For>
                    {/* The spacer takes the spare height while loading too, so rows keep their height when data arrives. */}
                    <Show when={props.fillHeight}>
                      <tr aria-hidden="true">
                        <td class="k2b-data-table__fill" colspan={columnCount()} />
                      </tr>
                    </Show>
                  </Show>
                </tbody>
              }
            >
              <Show
                when={groups()}
                fallback={
                  <tbody>
                    <For each={props.rows}>{(row, index) => renderRow(row, () => index() === props.rows.length - 1)}</For>
                    <Show when={props.fillHeight}>
                      <tr aria-hidden="true">
                        <td class="k2b-data-table__fill" colspan={columnCount()} />
                      </tr>
                    </Show>
                  </tbody>
                }
              >
                {(list) => (
                  <>
                    <For each={list()}>
                      {(group) => (
                        <tbody class="k2b-data-table__group">
                          <tr class="k2b-data-table__group-row">
                            <th scope="rowgroup" colspan={columnCount()}>
                              {group.label || "—"}
                              <span class="k2b-data-table__group-count">
                                <span aria-hidden="true">{group.rows.length}</span>
                                <span class="k2b-sr-only">, {dataTableMessages().rowCount({ count: group.rows.length })}</span>
                              </span>
                            </th>
                          </tr>
                          <For each={group.rows}>{(row, index) => renderRow(row, () => index() === group.rows.length - 1)}</For>
                        </tbody>
                      )}
                    </For>
                    <Show when={props.fillHeight}>
                      <tbody aria-hidden="true">
                        <tr>
                          <td class="k2b-data-table__fill" colspan={columnCount()} />
                        </tr>
                      </tbody>
                    </Show>
                  </>
                )}
              </Show>
            </Show>
            <Show when={props.footer}>
              {(footer) => (
                <tfoot class="k2b-data-table__foot" data-sticky="true">
                  <tr class="k2b-data-table__foot-row">
                    <For each={props.columns}>
                      {(col, index) => {
                        const value = () => footer().values?.[col.id];
                        return (
                          <td
                            class="k2b-data-table__footer-cell"
                            data-nowrap={nowrapAttr(col)}
                            data-align={alignAttr(col)}
                            data-priority={priorityAttr(col)}
                            data-highlighted={columnHighlighted(index())}
                            onMouseEnter={() => setHoveredColumnIfEnabled(index())}
                          >
                            {footer().renderCell
                              ? footer().renderCell!({ col, value: value(), render: (v) => renderTypedValue(col, v) })
                              : renderTypedValue(col, value())}
                          </td>
                        );
                      }}
                    </For>
                    <Show when={detailsPriority()}>
                      <td class="k2b-data-table__footer-cell k2b-data-table__details-toggle" />
                    </Show>
                  </tr>
                  {/* Totals of hidden columns stay readable under the totals row while the width hides them. */}
                  <Show when={detailsPriority()}>
                    <tr class="k2b-data-table__details" data-footer="true">
                      <td colspan={columnCount()}>
                        <dl>
                          <For each={hiddenColumns()}>
                            {(col) => (
                              <div data-priority={priorityAttr(col)}>
                                <dt>{detailLabel(col)}</dt>
                                <dd>
                                  {footer().renderCell
                                    ? footer().renderCell!({
                                        col,
                                        value: footer().values?.[col.id],
                                        render: (v) => renderTypedValue(col, v),
                                      })
                                    : renderTypedValue(col, footer().values?.[col.id])}
                                </dd>
                              </div>
                            )}
                          </For>
                        </dl>
                      </td>
                    </tr>
                  </Show>
                </tfoot>
              )}
            </Show>
          </table>
          <Show when={shouldRenderLoadMoreSentinel()}>
            <div ref={loadMoreRef} class="k2b-data-table__sentinel" aria-hidden="true" />
          </Show>
        </div>
        <For each={["y", "x"] as const}>
          {(axis) => (
            <div
              class="k2b-data-table__scrollbar"
              data-axis={axis}
              data-overflow={scrollbars()[axis].overflow ? "true" : undefined}
              aria-hidden="true"
              onPointerDown={(event) => startScrollbarDrag(event, axis)}
              onPointerMove={(event) => {
                if (event.currentTarget.hasPointerCapture(event.pointerId)) scrollFromPointer(event, axis);
              }}
              onPointerUp={(event) => event.currentTarget.releasePointerCapture(event.pointerId)}
              onPointerCancel={(event) => event.currentTarget.releasePointerCapture(event.pointerId)}
            >
              <span
                style={{
                  "--k2b-data-table-scroll-offset": `${scrollbars()[axis].offset}px`,
                  "--k2b-data-table-scroll-size": `${scrollbars()[axis].size}px`,
                }}
              />
            </div>
          )}
        </For>
      </Dynamic>
    </Show>
  );
}

const DataTablePanel = (props: DataTablePanelProps): JSX.Element => {
  const headingId = `k2b-data-table-${createUniqueId()}-heading`;
  const [hasHeading, setHasHeading] = createSignal(false);
  const context: DataTablePanelContextValue = {
    headingId,
    hasHeading,
    registerHeading: () => setHasHeading(true),
  };

  return (
    <DataTablePanelContext.Provider value={context}>
      <Paper as="section" class={`k2b-data-panel ${props.class ?? ""}`}>
        {props.children}
      </Paper>
    </DataTablePanelContext.Provider>
  );
};

const DataTableHeader = (props: DataTableHeaderProps): JSX.Element => {
  const panel = useContext(DataTablePanelContext);
  panel?.registerHeading();

  return (
    <div class={`k2b-data-panel__header ${props.class ?? ""}`}>
      <PanelHeader
        title={<span id={panel?.headingId}>{props.title}</span>}
        subtitle={props.subtitle}
        actions={props.children}
        as={props.as}
        size={props.size}
      />
    </div>
  );
};

const DataTableControls = (props: DataTableControlsProps): JSX.Element => (
  <div class={`k2b-data-panel__controls ${props.class ?? ""}`}>{props.children}</div>
);

const DataTablePanelFooter = (props: DataTablePanelFooterProps): JSX.Element => (
  <footer class={`k2b-data-panel__footer ${props.class ?? ""}`}>{props.children}</footer>
);

type DataTableComponent = {
  <T>(props: DataTableProps<T>): JSX.Element;
  Panel: (props: DataTablePanelProps) => JSX.Element;
  Header: (props: DataTableHeaderProps) => JSX.Element;
  Controls: (props: DataTableControlsProps) => JSX.Element;
  Footer: (props: DataTablePanelFooterProps) => JSX.Element;
};

const DataTable = DataTableRoot as DataTableComponent;
DataTable.Panel = DataTablePanel;
DataTable.Header = DataTableHeader;
DataTable.Controls = DataTableControls;
DataTable.Footer = DataTablePanelFooter;

export default DataTable;
