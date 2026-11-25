import {
  createContext,
  createEffect,
  createSignal,
  createUniqueId,
  For,
  type JSX,
  onCleanup,
  onMount,
  children as resolveChildren,
  Show,
  useContext,
} from "solid-js";
import { Dynamic } from "solid-js/web";
import { useUiMessages } from "../intl/messages";
import { useDrawer } from "./behavior/overlays";
import { ActionButton } from "./button";
import { RowOpen } from "./content";
import { linkOr } from "./link";
import { custom, Icon } from "./marks";
import { ConfirmDialog } from "./overlays";
import { Empty } from "./states";
import type { Action, Width } from "./types";

// ── Grip ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The seam between two columns: the one 1 px line, and on a line that moves its grip. The grip is the shape only;
 * dragging and the keyboard come with the behaviour layer.
 */
const Seam = (props: { grip?: { label: string; width: Width } }) => (
  <div class="k2-seam" aria-hidden={props.grip ? undefined : "true"}>
    <Show when={props.grip}>
      {(grip) => (
        <span
          class="k2-grip"
          data-k2-grip=""
          role="separator"
          tabindex="0"
          aria-orientation="vertical"
          aria-label={grip().label}
          aria-valuemin={grip().width.min}
          aria-valuenow={grip().width.default}
        />
      )}
    </Show>
  </div>
);

// ── Workspace ────────────────────────────────────────────────────────────────────────────────────────────────────

export type WorkspaceProps = {
  /** The sidebar column, such as `Nav`. */
  sidebar?: JSX.Element;
  /** The sidebar's minimum and default width; 200 and 248 px when not set. */
  sidebarWidth?: Width;
  /** The name of the sidebar's grip, such as "Width of the sidebar". */
  sidebarLabel?: string;
  /** The head across the main column: a `Bar` (56 px here) with tabs or a path and the actions. */
  head?: JSX.Element;
  /** The main action; on the phone it floats at the bottom right. */
  primary?: Action;
  /**
   * A detail opens beside the columns at times (a reader beside a list), and keeps at least this width (`true`:
   * 400 px). The workspace keeps its room also while it is closed: the sidebar never moves between column and drawer
   * when it opens, and `detailEmpty` stands in its place, so the column beside it keeps its width.
   */
  detail?: true | number;
  /**
   * What stands in the detail's place while none is open, such as `{ icon: "mail", text: "Keine Nachricht
   * ausgewählt" }`; "Nothing selected" in the language of the page when not set. Not on the phone, where the list is
   * the page.
   */
  detailEmpty?: { icon: string; text: string };
  /**
   * A `Pane` or `Pane.Split`, written inside the Workspace: its columns tell it their widths, so it knows when the
   * sidebar becomes a drawer. A column made before the Workspace (kept in a variable) is not counted.
   */
  children: JSX.Element;
};

const sidebarDefault: Width = { min: 200, default: 248 };
/** What a column without a width keeps at least: the concept's main column, 400 px (as in v2.css). */
const flexibleMin = 400;

/**
 * A column of the workspace and what it needs at least: its minimum, or 400 px for a column without a width; a detail
 * says so, since the workspace counts it once, open or closed.
 */
type Column = { readonly need: number; readonly detail: boolean };
/**
 * The columns of a workspace register here: the panes at its top, alone or side by side in a `Pane.Split`. The split
 * at the top also learns what stands in the place of a declared detail while none is open.
 */
type Columns = { register: (column: Column) => void; empty: () => { icon: string; text: string } | undefined };
const ColumnsContext = createContext<Columns | undefined>();

/**
 * The working surface of an app: a sidebar, a head and the columns below it, with one hairline between columns and
 * a grip on every line that moves. On the phone the sidebar leaves and columns become pages.
 *
 * The sidebar stands beside the columns while the workspace holds it at its default width and every column at its
 * minimum, with the lines between them; a detail it declares (`detail`) counts also while it is closed. Where it does
 * not (a tablet, a narrow window), the sidebar is a drawer from the start of the window, opened by a button at the
 * start of the head; picking an entry in it closes it. The stylesheet decides this from the workspace's own width, on
 * the server's page too, so nothing moves when the page comes alive. The drawer holds a second instance of the
 * sidebar, made while it is open: its scroll position and open folds start fresh. The rule is a `<style>` of the
 * workspace; a page whose content security policy allows no inline style keeps the sidebar as a column.
 */
export const Workspace = (props: WorkspaceProps) => {
  const t = useUiMessages();
  const width = () => props.sidebarWidth ?? sidebarDefault;
  // A part passed as JSX is made once, here, and read from here: reading the prop again would make it again (the
  // server's `Show` reads `when` more than once), and the browser would look for nodes the server never sent.
  const sidebar = resolveChildren(() => props.sidebar);
  const head = resolveChildren(() => props.head);
  const [columns, setColumns] = createSignal<readonly Column[]>([]);
  const register = (column: Column) => {
    setColumns((list) => [...list, column]);
    onCleanup(() => setColumns((list) => list.filter((other) => other !== column)));
  };
  // the detail the workspace declares, at its minimum; it counts open or closed
  const declared = () => (props.detail === undefined ? undefined : props.detail === true ? flexibleMin : props.detail);
  const empty = () =>
    declared() === undefined || columns().some((column) => column.detail)
      ? undefined
      : (props.detailEmpty ?? { icon: "click", text: t().nothingSelected });
  // The room the sidebar needs beside the columns: its default, every column's minimum and the lines between them, in
  // the workspace's content box (inside its edge), which the container query measures. A declared detail counts at
  // its declared minimum, open or closed, so the room stays the same when it opens.
  const room = () => {
    const list = columns().filter((column) => !column.detail);
    const open = columns().filter((column) => column.detail);
    const detail = declared() ?? (open.length > 0 ? Math.max(...open.map((column) => column.need)) : 0);
    const panes = list.length + (detail ? 1 : 0);
    return width().default + 1 + list.reduce((sum, column) => sum + column.need, 0) + detail + Math.max(0, panes - 1);
  };
  const id = createUniqueId();
  // Below that room (from 768 px on; the phone has its own pages) the sidebar is a drawer: one container query on
  // this workspace's width. It is the one rule here that is made per workspace, since the room is the workspace's own.
  const drawerRule = () =>
    `@media (min-width: 768px) { @container k2-ws-${id} (width < ${room()}px) { ` +
    `.k2-ui [data-k2-ws="${id}"] > :is(.k2-ws-side, .k2-ws-side + .k2-seam) { display: none; } ` +
    `.k2-ui [data-k2-ws="${id}"] > .k2-ws-main > [data-slot="head"] { --k2-ws-toggle: inline-flex; --k2-ws-drawer: 1; } } }`;
  const [drawerOpen, setDrawerOpen] = createSignal(false);
  const drawer = useDrawer(() => ({ open: drawerOpen(), onOpenChange: setDrawerOpen, side: "start" }));
  let element: HTMLDivElement | undefined;
  let toggle: HTMLElement | undefined;
  let aside: HTMLElement | undefined;
  let panel: HTMLElement | undefined;
  // When the window grows while the drawer is open, the sidebar is a column again and the drawer closes. Its button is
  // gone then, so a focus inside the drawer goes to the column's current entry instead.
  createEffect(() => {
    if (!drawerOpen() || !element) return;
    const sizes = new ResizeObserver(() => {
      if (!toggle || toggle.getClientRects().length > 0) return;
      const inside = panel?.contains(document.activeElement) ?? false;
      setDrawerOpen(false);
      if (inside)
        requestAnimationFrame(() => aside?.querySelector<HTMLElement>('[aria-current="page"], a[href], button:not([disabled])')?.focus());
    });
    sizes.observe(element);
    onCleanup(() => sizes.disconnect());
  });
  // Picking an entry (a link, a button that opens no disclosure, menu or dialog) closes the drawer; the page it opens is
  // what matters.
  const pick = (event: MouseEvent) => {
    if (event.target instanceof Element && event.target.closest("a[href], button:not([aria-expanded]):not([aria-haspopup])"))
      setDrawerOpen(false);
  };
  const toggleButton = () => (
    <drawer.Trigger
      ref={(button: HTMLElement) => {
        toggle = button;
      }}
      class="k2-btn k2-ws-toggle"
      data-variant="ghost"
      data-icon-only=""
      aria-label={t().showSidebar}
      title={t().showSidebar}
    >
      <Icon name="layout-sidebar" />
    </drawer.Trigger>
  );
  return (
    <div
      ref={element}
      class="k2-ws"
      data-k2-workspace=""
      data-k2-part="Workspace"
      data-k2-ws={id}
      style={custom({
        "--k2-ws-side": `${width().default}px`,
        "--k2-ws-side-min": `${width().min}px`,
        "container-name": sidebar() ? `k2-ws-${id}` : undefined,
      })}
    >
      <Show when={sidebar()}>
        <aside ref={aside} class="k2-ws-side" data-k2-column="">
          {sidebar()}
        </aside>
        <Seam grip={{ label: props.sidebarLabel ?? "Sidebar", width: width() }} />
      </Show>
      <div class="k2-ws-main" data-k2-column="">
        <Show when={head() || sidebar()}>
          <div class="k2-slot" data-slot="head" data-toggle-only={head() ? undefined : ""}>
            <Show when={sidebar()}>{toggleButton()}</Show>
            {head()}
          </div>
        </Show>
        <ColumnsContext.Provider value={{ register, empty }}>{props.children}</ColumnsContext.Provider>
      </div>
      <Show when={sidebar()}>
        <style>{drawerRule()}</style>
        {/* the sidebar once more, made only while the drawer is open (in the browser, after a press) */}
        <drawer.Popup
          ref={(element: HTMLElement) => {
            panel = element;
          }}
          class="k2-drawer"
          data-k2-part="Drawer"
          aria-label={t().sidebar}
          style={custom({ "--k2-drawer-w": `${width().default}px` })}
          backdrop={{ class: "k2-backdrop" }}
          onClick={pick}
        >
          {props.sidebar}
        </drawer.Popup>
      </Show>
      <Show when={props.primary}>
        {(action) => (
          // a disabled link is an anchor without an address, as in `Button`
          <Dynamic
            component={action().disabled && action().href !== undefined ? "a" : linkOr(action().href, "button")}
            type={action().href !== undefined ? undefined : "button"}
            class="k2-btn k2-fab"
            data-variant="primary"
            href={action().disabled ? undefined : action().href}
            onNavigate={action().href !== undefined && !action().disabled ? action().onNavigate : undefined}
            disabled={action().href === undefined ? action().disabled : undefined}
            aria-disabled={action().href !== undefined && action().disabled ? "true" : undefined}
            onClick={() => {
              if (!action().disabled) action().onClick?.();
            }}
          >
            <Show when={action().icon}>{(name) => <Icon name={name()} />}</Show>
            {action().label}
          </Dynamic>
        )}
      </Show>
      {/* the alert dialog that answers `Dialog.confirm`, so every v2 page can ask; it renders only while it asks */}
      <ConfirmDialog host={() => element} />
    </div>
  );
};

// ── Pane and Pane.Split ──────────────────────────────────────────────────────────────────────────────────────────

type SplitEntry = { readonly width?: Width; readonly label?: string; element?: HTMLElement };
/** A pane inside a split registers its width and name for the seam beside it, for as long as it exists. */
const SplitContext = createContext<(entry: SplitEntry) => void>();

export type PaneProps = {
  /** The head of this column: a `Bar` (56 px; 52 px for a reader beside a list) or `Tabs`. */
  head?: JSX.Element;
  /** The status row of this column (52 px), such as `StatusRow`. */
  status?: JSX.Element;
  /** A column that can be dragged wider: its minimum and default width. Only inside `Pane.Split`. */
  width?: Width;
  /** The name of the column and of its grip, such as "List". */
  label?: string;
  /**
   * The detail of a list (a reader): beside the list on a wide screen. On the phone, while it is there (something is
   * open), it is the page and the list gives way; render it only while something is open. What is open belongs in
   * the address, so reload, back and forward show the same. A detail that closes in place hands the focus back to
   * what opened it, such as the row.
   */
  detail?: boolean;
  /**
   * The way back to the list on the phone, where the detail is a page of its own, such as "Posteingang". Give it an
   * `href`: the address of the list without the open entry. While it is there, the head of the workspace gives way on
   * the phone, so the way back is the one bar above the detail; it is the part `Back`, which a shell may show in its
   * own bar instead. With `back`, the close × of the detail's head needs no `keep`: like every head action without
   * it, the × gives way on the phone, so the detail has one way back there.
   */
  back?: Action;
  /** The side column of a record (the info column): quieter sections. */
  side?: boolean;
  /**
   * A name under which the page keeps this column's scroll position, such as "mail-list": back and forward bring
   * the list back where it was (the page restores every `data-scroll-preserve` region, as v1's `ScrollArea` does).
   */
  scrollKey?: string;
  /** Bands, rows, sections; the pane pads nothing. */
  children?: JSX.Element;
};

/** A column that scrolls. It has no padding and no gutter, so every band in it reaches both edges. */
export const Pane = (props: PaneProps) => {
  const entry: SplitEntry = {
    get width() {
      return props.width;
    },
    get label() {
      return props.label;
    },
  };
  useContext(SplitContext)?.(entry);
  // a column at the top of a workspace tells it what it needs; panes inside this one are not its columns
  useContext(ColumnsContext)?.register({
    get need() {
      return props.width?.min ?? flexibleMin;
    },
    get detail() {
      return props.detail === true;
    },
  });
  const head = resolveChildren(() => props.head);
  const status = resolveChildren(() => props.status);
  let section: HTMLElement | undefined;
  // A detail appears because something opened it, which then has the focus (the row). When the detail goes while the
  // focus is in it (its way back, its close button), the focus returns there instead of falling to the page.
  onMount(() => {
    if (!props.detail) return;
    const opener = document.activeElement;
    if (!(opener instanceof HTMLElement) || opener === document.body || section?.contains(opener)) return;
    onCleanup(() => {
      const inside = section?.contains(document.activeElement) ?? false;
      queueMicrotask(() => {
        const lost = inside || document.activeElement === null || document.activeElement === document.body;
        if (lost && opener.isConnected) opener.focus();
      });
    });
  });
  return (
    <section
      ref={(element) => {
        entry.element = element;
        section = element;
      }}
      class="k2-pane"
      data-k2-part="Pane"
      data-k2-column=""
      aria-label={props.label}
      data-width={props.width ? "" : undefined}
      data-detail={props.detail ? "" : undefined}
      data-side={props.side ? "" : undefined}
      style={custom({
        "--k2-pane-w": props.width ? `${props.width.default}px` : undefined,
        "--k2-pane-min": props.width ? `${props.width.min}px` : undefined,
      })}
    >
      {/* the way back shows only on the phone, above the head of the detail; a public part, so a shell can find it */}
      <Show when={props.back}>
        {(back) => (
          <div class="k2-pane-back" data-k2-part="Back">
            {/* a long name is cut with "…"; the whole name is the hint under the pointer */}
            <ActionButton action={{ icon: "chevron-left", ...back() }} variant="text" titled />
          </div>
        )}
      </Show>
      <Show when={head()}>
        <div class="k2-slot" data-slot="head">
          {head()}
        </div>
      </Show>
      <Show when={status()}>
        <div class="k2-slot" data-slot="status">
          {status()}
        </div>
      </Show>
      <div class="k2-scroll" data-scroll-preserve={props.scrollKey}>
        <ColumnsContext.Provider value={undefined}>{props.children}</ColumnsContext.Provider>
      </div>
    </section>
  );
};

/**
 * Panes side by side inside content: a list beside its reader, a main column beside its info column. One hairline
 * between them; where a pane has a `width`, its line carries a grip.
 */
Pane.Split = (props: { children: JSX.Element }) => {
  const [entries, setEntries] = createSignal<readonly SplitEntry[]>([]);
  const register = (entry: SplitEntry) => {
    setEntries((list) => [...list, entry]);
    onCleanup(() => setEntries((list) => list.filter((other) => other !== entry)));
  };
  // at the top of a workspace that declares a detail: what stands in its place while none is open
  const columns = useContext(ColumnsContext);
  return (
    <SplitContext.Provider value={register}>
      <SplitBody entries={entries()} empty={columns?.empty()}>
        {props.children}
      </SplitBody>
    </SplitContext.Provider>
  );
};

/**
 * Renders the panes first (each registers its width), then puts a seam after every pane; the stylesheet hides the one
 * after the last. Panes may come and go (`Show`): each takes its own seam with it, and the grips follow. Every entry
 * of the list is the same two nodes, so nothing in it comes and goes on its own (that would not be removed cleanly
 * after hydration). In the browser a pane's entry is found by its element, on the server by its order.
 */
const SplitBody = (props: { entries: readonly SplitEntry[]; empty: { icon: string; text: string } | undefined; children: JSX.Element }) => {
  const resolved = resolveChildren(() => props.children);
  // a pane hidden by `Show` stays in the list as nothing: it gets no seam
  const panes = () => resolved.toArray().filter((pane) => pane !== undefined && pane !== null && pane !== "");
  const entryOf = (index: number) => {
    const pane = panes()[index];
    if (pane === undefined) return undefined;
    return props.entries.find((entry) => entry.element !== undefined && entry.element === pane) ?? props.entries[index];
  };
  // The seam after pane `index`: the pane on its right moves it if it has a width, else the pane on its left. The place
  // of a detail that is not open counts as a pane without a width, so the grip stays where it is when it opens.
  const grip = (index: number) => {
    const left = entryOf(index);
    const right = entryOf(index + 1) ?? (props.empty && index === panes().length - 1 ? {} : undefined);
    if (!right) return undefined;
    const moving = right.width ? right : left?.width ? left : undefined;
    return moving?.width ? { label: moving.label ?? "Column", width: moving.width } : undefined;
  };
  return (
    <div class="k2-split" data-k2-part="Pane.Split">
      <For each={panes()}>
        {(pane, index) => (
          <>
            {pane}
            <Seam grip={grip(index())} />
          </>
        )}
      </For>
      {/* the place of the declared detail while none is open: the column beside it keeps its width (not on the phone) */}
      <Show when={props.empty}>
        {(empty) => (
          <section class="k2-pane" data-k2-part="Pane" data-detail-empty="" aria-label={empty().text}>
            <div class="k2-scroll">
              <Empty icon={empty().icon} text={empty().text} />
            </div>
          </section>
        )}
      </Show>
    </div>
  );
};

// ── Bar ──────────────────────────────────────────────────────────────────────────────────────────────────────────

export type BarProps = {
  /** The start place: a title, a path, tabs, an inline line. */
  start?: JSX.Element;
  /** The end place: buttons, a search, a person. */
  end?: JSX.Element;
};

/**
 * A bar of fixed height with a line below. Its height comes from its place: 56 as the head of a workspace or pane,
 * 52 as a status row, 40 on its own. Controls in it take the height that leaves equal air above and below. The
 * stylesheet reads the place from the slot the bar stands in, so a bar built ahead and passed on behaves the same.
 * In a column narrower than 480 px, a bar in the flow whose start is an `Inline` wraps instead of cutting: its things
 * and its end flow as one line, one line stays 40, and only a second line makes the bar higher.
 */
export const Bar = (props: BarProps) => {
  const start = resolveChildren(() => props.start);
  const end = resolveChildren(() => props.end);
  return (
    <div class="k2-bar" data-k2-part="Bar">
      <Show when={start() !== undefined}>
        <div class="k2-bar-start">{start()}</div>
      </Show>
      <Show when={end() !== undefined}>
        <div class="k2-bar-end">{end()}</div>
      </Show>
    </div>
  );
};

// ── Band ─────────────────────────────────────────────────────────────────────────────────────────────────────────

export type BandProps = {
  /** A tone only by meaning: a note, AI, "yours", wrong, waiting. */
  tone?: "note" | "ai" | "yours" | "bad" | "warn";
  label?: string;
  children: JSX.Element;
};

/** A band of free height with one line below, from edge to edge. What stands in it draws no line of its own. */
export const Band = (props: BandProps) => (
  <section class="k2-band" data-k2-part="Band" data-tone={props.tone} aria-label={props.label}>
    {props.children}
  </section>
);

// ── Cells ────────────────────────────────────────────────────────────────────────────────────────────────────────

export type CellProps = {
  icon: string;
  /** The data colour of the symbol, such as the colour of an area. */
  color?: string;
  label: string;
  value: JSX.Element;
  /** A quiet line under the value. */
  meta?: JSX.Element;
  /** The cell leads to this page: a chevron at its end. */
  href?: string;
};

/** Two to four equal cells side by side with a line between them; one under the other on the phone. */
export const Cells = (props: { children: JSX.Element }) => (
  <div class="k2-cells" data-k2-part="Cells">
    {props.children}
  </div>
);

Cells.Cell = (props: CellProps) => {
  const meta = resolveChildren(() => props.meta);
  return (
    // a cell that leads somewhere: its label is the link, stretched over the cell, so a value may hold its own controls
    <div
      class="k2-cell"
      data-k2-part="Cells.Cell"
      data-open={props.href !== undefined ? "" : undefined}
      style={custom({ "--k2-c": props.color })}
    >
      <Icon name={props.icon} />
      <span class="k2-cell-label">
        <RowOpen href={props.href}>{props.label}</RowOpen>
      </span>
      <Show when={props.href} fallback={<span />}>
        <i class="ti ti-chevron-right k2-icon k2-cell-go" aria-hidden="true" />
      </Show>
      <span class="k2-cell-value">{props.value}</span>
      <Show when={meta() !== undefined}>
        <span class="k2-cell-meta">{meta()}</span>
      </Show>
    </div>
  );
};

// ── Tiles ────────────────────────────────────────────────────────────────────────────────────────────────────────

export type Tile = { icon: string; title: string; meta?: string; href?: string };

/** Like things side by side, such as attachments. Each is pressed, so each is round; never nested. */
export type TilesProps = { items: readonly Tile[]; more?: Action; label?: string };

export const Tiles = (props: TilesProps) => (
  <div class="k2-tiles" data-k2-part="Tiles" role="list" aria-label={props.label}>
    <For each={props.items}>
      {(tile) => (
        <div class="k2-tile" role="listitem" data-open={tile.href !== undefined ? "" : undefined}>
          <Icon name={tile.icon} />
          <span>
            <span class="k2-tile-title">
              <RowOpen href={tile.href}>{tile.title}</RowOpen>
            </span>
            <Show when={tile.meta}>
              <span class="k2-t-meta">{tile.meta}</span>
            </Show>
          </span>
        </div>
      )}
    </For>
    <Show when={props.more}>{(more) => <ActionButton action={more()} variant="text" />}</Show>
  </div>
);

// ── Canvas ───────────────────────────────────────────────────────────────────────────────────────────────────────

export type CanvasProps = {
  /** What the drawing shows, for assistive technology. */
  label: string;
  /** The height of the drawing in px; the width comes from its place. */
  height?: number;
  children: JSX.Element;
};

/**
 * The one way out: a surface with its own drawing, where an app may write its own CSS. Never measured by the rules.
 * It draws no line of its own; the structure around it separates it, and a drawing that needs an edge draws it.
 */
export const Canvas = (props: CanvasProps) => (
  <div
    class="k2-canvas"
    data-k2-part="Canvas"
    data-k2-canvas=""
    role="group"
    aria-label={props.label}
    data-height={props.height !== undefined ? "" : undefined}
    style={custom({ "--k2-canvas-h": props.height !== undefined ? `${props.height}px` : undefined })}
  >
    {props.children}
  </div>
);
