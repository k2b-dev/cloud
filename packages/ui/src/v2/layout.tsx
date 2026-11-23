import { createContext, createSignal, For, type JSX, onCleanup, onMount, children as resolveChildren, Show, useContext } from "solid-js";
import { Dynamic } from "solid-js/web";
import { ActionButton } from "./button";
import { RowOpen } from "./content";
import { custom, Icon } from "./marks";
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
  /** A `Pane` or `Pane.Split`. */
  children: JSX.Element;
};

const sidebarDefault: Width = { min: 200, default: 248 };

/**
 * The working surface of an app: a sidebar, a head and the columns below it, with one hairline between columns and
 * a grip on every line that moves. On the phone the sidebar leaves and columns become pages.
 */
export const Workspace = (props: WorkspaceProps) => {
  const width = () => props.sidebarWidth ?? sidebarDefault;
  // A part passed as JSX is made once, here, and read from here: reading the prop again would make it again (the
  // server's `Show` reads `when` more than once), and the browser would look for nodes the server never sent.
  const sidebar = resolveChildren(() => props.sidebar);
  const head = resolveChildren(() => props.head);
  return (
    <div
      class="k2-ws"
      data-k2-workspace=""
      data-k2-part="Workspace"
      style={custom({ "--k2-ws-side": `${width().default}px`, "--k2-ws-side-min": `${width().min}px` })}
    >
      <Show when={sidebar()}>
        <aside class="k2-ws-side" data-k2-column="">
          {sidebar()}
        </aside>
        <Seam grip={{ label: props.sidebarLabel ?? "Sidebar", width: width() }} />
      </Show>
      <div class="k2-ws-main" data-k2-column="">
        <Show when={head()}>
          <div class="k2-slot" data-slot="head">
            {head()}
          </div>
        </Show>
        {props.children}
      </div>
      <Show when={props.primary}>
        {(action) => (
          <Dynamic
            component={action().href !== undefined ? "a" : "button"}
            type={action().href !== undefined ? undefined : "button"}
            class="k2-btn k2-fab"
            data-variant="primary"
            href={action().href}
            onClick={() => action().onClick?.()}
          >
            <Show when={action().icon}>{(name) => <Icon name={name()} />}</Show>
            {action().label}
          </Dynamic>
        )}
      </Show>
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
   * `href`: the address of the list without the open entry.
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
      {/* the way back shows only on the phone, above the head of the detail */}
      <Show when={props.back}>
        {(back) => (
          <div class="k2-pane-back">
            <ActionButton action={{ icon: "chevron-left", ...back() }} variant="text" />
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
        {props.children}
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
  return (
    <SplitContext.Provider value={register}>
      <SplitBody entries={entries()}>{props.children}</SplitBody>
    </SplitContext.Provider>
  );
};

/**
 * Renders the panes first (each registers its width), then puts a seam after every pane; the stylesheet hides the one
 * after the last. Panes may come and go (`Show`): each takes its own seam with it, and the grips follow. Every entry
 * of the list is the same two nodes, so nothing in it comes and goes on its own (that would not be removed cleanly
 * after hydration). In the browser a pane's entry is found by its element, on the server by its order.
 */
const SplitBody = (props: { entries: readonly SplitEntry[]; children: JSX.Element }) => {
  const resolved = resolveChildren(() => props.children);
  // a pane hidden by `Show` stays in the list as nothing: it gets no seam
  const panes = () => resolved.toArray().filter((pane) => pane !== undefined && pane !== null && pane !== "");
  const entryOf = (index: number) => {
    const pane = panes()[index];
    if (pane === undefined) return undefined;
    return props.entries.find((entry) => entry.element !== undefined && entry.element === pane) ?? props.entries[index];
  };
  // The seam after pane `index`: the pane on its right moves it if it has a width, else the pane on its left.
  const grip = (index: number) => {
    const left = entryOf(index);
    const right = entryOf(index + 1);
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
