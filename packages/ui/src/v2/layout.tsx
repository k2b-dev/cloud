import { createContext, For, type JSX, onCleanup, children as resolveChildren, Show, useContext } from "solid-js";
import { Dynamic } from "solid-js/web";
import { ActionButton } from "./button";
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
  return (
    <div
      class="k2-ws"
      data-k2-workspace=""
      data-k2-part="Workspace"
      style={custom({ "--k2-ws-side": `${width().default}px`, "--k2-ws-side-min": `${width().min}px` })}
    >
      <Show when={props.sidebar}>
        <aside class="k2-ws-side" data-k2-column="">
          {props.sidebar}
        </aside>
        <Seam grip={{ label: props.sidebarLabel ?? "Sidebar", width: width() }} />
      </Show>
      <div class="k2-ws-main" data-k2-column="">
        <Show when={props.head}>
          <div class="k2-slot" data-slot="head">
            {props.head}
          </div>
        </Show>
        {props.children}
      </div>
      <Show when={props.primary}>
        {(action) => (
          <a class="k2-btn k2-fab" data-variant="primary" href={action().href} onClick={() => action().onClick?.()}>
            <Show when={action().icon}>{(name) => <Icon name={name()} />}</Show>
            {action().label}
          </a>
        )}
      </Show>
    </div>
  );
};

// ── Pane and Pane.Split ──────────────────────────────────────────────────────────────────────────────────────────

type SplitEntry = { width?: Width; label?: string };
const SplitContext = createContext<SplitEntry[]>();

export type PaneProps = {
  /** The head of this column: a `Bar` (56 px; 52 px for a reader beside a list) or `Tabs`. */
  head?: JSX.Element;
  /** The status row of this column (52 px), such as `StatusRow`. */
  status?: JSX.Element;
  /** A column that can be dragged wider: its minimum and default width. Only inside `Pane.Split`. */
  width?: Width;
  /** The name of the column and of its grip, such as "List". */
  label?: string;
  /** The detail of a list (a reader): beside the list on a wide screen, its own page on the phone. */
  detail?: boolean;
  /** The side column of a record (the info column): quieter sections. */
  side?: boolean;
  /** Bands, rows, sections; the pane pads nothing. */
  children?: JSX.Element;
};

/** A column that scrolls. It has no padding and no gutter, so every band in it reaches both edges. */
export const Pane = (props: PaneProps) => {
  // A pane shown later (a reader that opens) takes its place after the others; one that leaves gives its place back.
  const split = useContext(SplitContext);
  const entry: SplitEntry = {
    get width() {
      return props.width;
    },
    get label() {
      return props.label;
    },
  };
  split?.push(entry);
  onCleanup(() => {
    const index = split?.indexOf(entry) ?? -1;
    if (index >= 0) split?.splice(index, 1);
  });
  return (
    <section
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
      <Show when={props.head}>
        <div class="k2-slot" data-slot="head">
          {props.head}
        </div>
      </Show>
      <Show when={props.status}>
        <div class="k2-slot" data-slot="status">
          {props.status}
        </div>
      </Show>
      <div class="k2-scroll">{props.children}</div>
    </section>
  );
};

/**
 * Panes side by side inside content: a list beside its reader, a main column beside its info column. One hairline
 * between them; where a pane has a `width`, its line carries a grip.
 */
Pane.Split = (props: { children: JSX.Element }) => {
  const entries: SplitEntry[] = [];
  return (
    <SplitContext.Provider value={entries}>
      <SplitBody entries={entries}>{props.children}</SplitBody>
    </SplitContext.Provider>
  );
};

/**
 * Renders the panes first (each registers its width), then puts a seam between every two of them. Panes that come and
 * go (`<Show>` around a reader) keep the others in place: only the seams are drawn again.
 */
const SplitBody = (props: { entries: SplitEntry[]; children: JSX.Element }) => {
  const resolved = resolveChildren(() => props.children);
  const seam = (index: number) => {
    const left = props.entries[index - 1];
    const right = props.entries[index];
    const moving = right?.width ? right : left?.width ? left : undefined;
    return <Seam grip={moving?.width ? { label: moving.label ?? "Column", width: moving.width } : undefined} />;
  };
  return (
    <div class="k2-split" data-k2-part="Pane.Split">
      {resolved.toArray().map((pane, index) => (index > 0 ? [seam(index), pane] : pane))}
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
export const Bar = (props: BarProps) => (
  <div class="k2-bar" data-k2-part="Bar">
    <Show when={props.start !== undefined}>
      <div class="k2-bar-start">{props.start}</div>
    </Show>
    <Show when={props.end !== undefined}>
      <div class="k2-bar-end">{props.end}</div>
    </Show>
  </div>
);

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
export const Cells = (props: { children: JSX.Element }) => {
  const resolved = resolveChildren(() => props.children);
  const count = () => Math.max(1, Math.min(4, resolved.toArray().length));
  return (
    <div class="k2-cells" data-k2-part="Cells" style={custom({ "--k2-cells": String(count()) })}>
      {resolved()}
    </div>
  );
};

Cells.Cell = (props: CellProps) => (
  <Dynamic
    component={props.href ? "a" : "div"}
    class="k2-cell"
    data-k2-part="Cells.Cell"
    href={props.href}
    style={custom({ "--k2-c": props.color })}
  >
    <Icon name={props.icon} />
    <span class="k2-cell-label">{props.label}</span>
    <Show when={props.href} fallback={<span />}>
      <i class="ti ti-chevron-right k2-icon k2-cell-go" aria-hidden="true" />
    </Show>
    <span class="k2-cell-value">{props.value}</span>
    <Show when={props.meta !== undefined}>
      <span class="k2-cell-meta">{props.meta}</span>
    </Show>
  </Dynamic>
);

// ── Tiles ────────────────────────────────────────────────────────────────────────────────────────────────────────

export type Tile = { icon: string; title: string; meta?: string; href?: string };

/** Like things side by side, such as attachments. Each is pressed, so each is round; never nested. */
export const Tiles = (props: { items: readonly Tile[]; more?: Action; label?: string }) => (
  <div class="k2-tiles" data-k2-part="Tiles" role="list" aria-label={props.label}>
    <For each={props.items}>
      {(tile) => (
        <a class="k2-tile" href={tile.href} role="listitem">
          <Icon name={tile.icon} />
          <span>
            <span class="k2-tile-title">{tile.title}</span>
            <Show when={tile.meta}>
              <span class="k2-t-meta">{tile.meta}</span>
            </Show>
          </span>
        </a>
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

/** The one way out: a surface with its own drawing, where an app may write its own CSS. Never measured by the rules. */
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
