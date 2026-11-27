import {
  type Accessor,
  createContext,
  createEffect,
  createMemo,
  createSignal,
  createUniqueId,
  For,
  type JSX,
  onCleanup,
  onMount,
  children as resolveChildren,
  Show,
  splitProps,
  useContext,
} from "solid-js";
import { Dynamic } from "solid-js/web";
import { useUiMessages } from "../intl/messages";
import { useDrawer } from "./behavior/overlays";
import { type GripOptions, useGrip } from "./behavior/resize";
import { ActionButton } from "./button";
import { RowOpen } from "./content";
import { linkOr } from "./link";
import { Avatar, Chip, custom, Icon, Mark, Spark, type SparkProps } from "./marks";
import { ConfirmDialog } from "./overlays";
import { Empty, PlaceholderValue } from "./states";
import { Toasts } from "./toast";
import { type Action, type OnNavigate, type Person, type Status, type Width, widthRange } from "./types";

// ── Grip ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Keeps every grip in the vertical middle of the part of its line that is in sight (mockup resize.js): a line taller
 * than its scroller, such as the one beside a record's info column, would otherwise hold its grip below the window.
 * Until the page is live the grip stands in the middle of the line, at most half a window down (CSS). One frame
 * measures every grip first and then moves them, so several grips cost one layout.
 */
const grips = new Map<HTMLElement, HTMLElement[]>();
let frame = 0;
let sizes: ResizeObserver | undefined;

/** The middle of the part of the grip's line in sight, from the line's top; nothing when the line is out of sight. */
const middleOf = (grip: HTMLElement, clips: readonly HTMLElement[]) => {
  const seam = grip.parentElement;
  if (!seam) return undefined;
  const line = seam.getBoundingClientRect();
  let top = Math.max(line.top, 0);
  let bottom = Math.min(line.bottom, window.innerHeight);
  for (const clip of clips) {
    const box = clip.getBoundingClientRect();
    top = Math.max(top, box.top);
    bottom = Math.min(bottom, box.bottom);
  }
  const half = grip.offsetHeight / 2;
  // a line out of sight keeps its grip where it was
  return bottom - top < grip.offsetHeight ? undefined : Math.round((top + bottom) / 2 - line.top - half);
};
const placeAll = () => {
  frame = 0;
  const places = [...grips].map(([grip, clips]) => [grip, middleOf(grip, clips)] as const);
  for (const [grip, top] of places) if (top !== undefined) grip.style.setProperty("--k2-grip-top", `${top}px`);
};
const schedule = () => {
  frame ||= requestAnimationFrame(placeAll);
};

const centerGrip = (grip: HTMLElement) => {
  onMount(() => {
    const seam = grip.parentElement;
    // the boxes that clip the line: every scroller above it (they stay while the grip lives)
    const clips: HTMLElement[] = [];
    for (let up = seam?.parentElement; up; up = up.parentElement)
      if (/^(auto|scroll|hidden|clip)$/.test(getComputedStyle(up).overflowY)) clips.push(up);
    if (!grips.size) {
      sizes = new ResizeObserver(schedule);
      // a scroll anywhere above moves the part in sight; capture hears the scrollers, which do not bubble it
      document.addEventListener("scroll", schedule, { capture: true, passive: true });
      window.addEventListener("resize", schedule, { passive: true });
    }
    grips.set(grip, clips);
    if (seam) sizes?.observe(seam);
    schedule();
    onCleanup(() => {
      grips.delete(grip);
      if (seam) sizes?.unobserve(seam);
      if (grips.size) return;
      cancelAnimationFrame(frame);
      frame = 0;
      sizes?.disconnect();
      sizes = undefined;
      document.removeEventListener("scroll", schedule, { capture: true });
      window.removeEventListener("resize", schedule);
    });
  });
};

/** A grip on a seam: its name and the one column it moves. */
type SeamGrip = Omit<GripOptions, "label" | "min" | "reset" | "observe"> & { label: string; width: { min: number; default: number } };

/** The grip of a seam: a pointer drag or the keys move the width of its column (`useGrip`). */
const SeamGrip = (props: { grip: SeamGrip }) => {
  const grip = useGrip({
    label: () => props.grip.label,
    value: () => props.grip.value(),
    onChange: (px) => props.grip.onChange(px),
    min: () => props.grip.width.min,
    reset: () => props.grip.width.default,
    direction: () => props.grip.direction(),
    measure: (element) => props.grip.measure(element),
    // the row of columns around the seam and every column in it
    observe: (element) => {
      const row = element.parentElement?.parentElement;
      return row ? [row, ...row.children] : [];
    },
  });
  const [ref, attrs] = splitProps(grip, ["ref"]);
  return (
    <span
      ref={(element) => {
        ref.ref(element);
        centerGrip(element);
      }}
      class="k2-grip"
      data-k2-grip=""
      {...attrs}
    />
  );
};

/** The seam between two columns: the one 1 px line, and on a line that moves its grip. */
const Seam = (props: { grip?: SeamGrip }) => (
  <div class="k2-seam" aria-hidden={props.grip ? undefined : "true"}>
    <Show when={props.grip}>{(grip) => <SeamGrip grip={grip()} />}</Show>
  </div>
);

/** How much `element` can give: its rendered width above its own minimum. */
const slackOf = (element: Element) => {
  const width = element.getBoundingClientRect().width;
  return Math.max(0, width - (Number.parseFloat(getComputedStyle(element).minWidth) || 0));
};

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
 * says so, since the workspace counts it once, open or closed. A context column beside a single main column (`away`)
 * needs no room: where there is none beside, it stands under the main column.
 */
type Column = { readonly need: number; readonly detail: boolean; readonly away?: boolean };
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
  const width = () => widthRange(props.sidebarWidth ?? sidebarDefault);
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
    const counted = columns().filter((column) => !column.away);
    const list = counted.filter((column) => !column.detail);
    const open = counted.filter((column) => column.detail);
    const detail = declared() ?? (open.length > 0 ? Math.max(...open.map((column) => column.need)) : 0);
    const panes = list.length + (detail ? 1 : 0);
    return width().default + 1 + list.reduce((sum, column) => sum + column.need, 0) + detail + Math.max(0, panes - 1);
  };
  const id = createUniqueId();
  // Below that room (from 768 px on; the phone has its own pages) the sidebar is a drawer: one container query on
  // this workspace's width. It is the one rule here that is made per workspace, since the room is the workspace's own.
  // A sidebar its grip made wider gives way first when the window narrows, so the columns keep their minimum.
  const drawerRule = () =>
    `@media (min-width: 768px) { .k2-ui [data-k2-ws="${id}"] > .k2-ws-side { max-width: calc(100% - ${room() - width().default}px); } ` +
    `@container k2-ws-${id} (width < ${room()}px) { ` +
    `.k2-ui [data-k2-ws="${id}"] > :is(.k2-ws-side, .k2-ws-side + .k2-seam) { display: none; } ` +
    `.k2-ui [data-k2-ws="${id}"] > .k2-ws-main > [data-slot="head"] { --k2-ws-toggle: inline-flex; --k2-ws-drawer: 1; } } }`;
  const [drawerOpen, setDrawerOpen] = createSignal(false);
  const drawer = useDrawer(() => ({ open: drawerOpen(), onOpenChange: setDrawerOpen, side: "start" }));
  let element: HTMLDivElement | undefined;
  let toggle: HTMLElement | undefined;
  let aside: HTMLElement | undefined;
  let panel: HTMLElement | undefined;
  // The sidebar's width while its grip has moved it; its default until then. It gives the columns at most what they
  // need beyond their minimum (the room above without the sidebar's default).
  const [side, setSide] = createSignal<number>();
  const sideWidth = () => side() ?? width().default;
  // a fixed sidebar has no grip
  const sideGrip = (): SeamGrip | undefined =>
    width().fixed
      ? undefined
      : {
          label: props.sidebarLabel ?? "Sidebar",
          width: width(),
          value: sideWidth,
          onChange: setSide,
          direction: () => 1,
          measure: () => {
            const now = aside?.getBoundingClientRect().width;
            if (!now || !element) return undefined;
            return { now, max: element.clientWidth - room() + width().default };
          },
        };
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
        "--k2-ws-side": `${sideWidth()}px`,
        "--k2-ws-side-min": `${width().min}px`,
        "container-name": sidebar() ? `k2-ws-${id}` : undefined,
      })}
    >
      <Show when={sidebar()}>
        <aside ref={aside} class="k2-ws-side" data-k2-column="">
          {sidebar()}
        </aside>
        <Seam grip={sideGrip()} />
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
      {/* the one toaster of the page: every `useToast` shows here, also one called above the Workspace */}
      <Toasts />
    </div>
  );
};

// ── Pane and Pane.Split ──────────────────────────────────────────────────────────────────────────────────────────

type SplitEntry = {
  readonly width?: Width;
  readonly label?: string;
  /** A context column (`side`): the split lets it give way to the end of the main column where it lacks the room. */
  readonly side?: PaneProps["side"];
  element?: HTMLElement;
  /** The pane's width in px while its grip has moved it. */
  size?: Accessor<number | undefined>;
  resize?: (px: number) => void;
};
/** A pane inside a split registers its width and name for the seam beside it, for as long as it exists. */
const SplitContext = createContext<(entry: SplitEntry) => void>();
/** Whether the split is a main column with one context column after it: then the context gives way where there is no room. */
const ContextualContext = createContext<Accessor<boolean>>();

export type PaneProps = {
  /** The head of this column: a `Bar` (56 px; 52 px for a reader beside a list) or `Tabs`. */
  head?: JSX.Element;
  /**
   * What stays under the head while the column scrolls: a `StatusRow` (52 px) above a list, or a `Bar` (40 px) with
   * the state of an open entry, such as "3 Nachrichten · Wartet auf Antwort · Tag" above a reader.
   */
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
  /**
   * The context column (quieter sections): the info column of a record, what a form feeds, a chart beside a table, or
   * the right half of a detail that grows on a large screen (who and what happened, beside what it is).
   *
   * In a `Pane.Split` of exactly one main column and this context column after it, the context stands beside the main
   * column only where the split holds both at their default widths (a column without a `width` at 400 px). With less
   * room it gives way to the end of the main column: the split then scrolls in one piece, the main column first and
   * the context under it at the full width, so the main column is never squeezed and nothing hides; and it needs no
   * room of the workspace, so the sidebar never becomes a drawer for it. `{ from }` asks for more room, in px of the
   * split, for a main column that needs it, such as a table (`{ from: 1400 }`: a large screen); never less than the
   * defaults. The rule is a `<style>` beside the split, made from these widths on the server too; a page whose content
   * security policy allows no inline style keeps the context column beside, as in any other split.
   *
   * In any other split (a list, its reader and an info column) it stands beside as every column does and counts
   * toward the room of the workspace. Known: the split's rule asks for its panes as its own children, so a pane that
   * an island wraps on its own gives way only where the island's wrapper is transparent to `>`.
   */
  side?: boolean | { from: number };
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
  // the width the grip beside it gave it; its default until then
  const [size, setSize] = createSignal<number>();
  const entry: SplitEntry = {
    get width() {
      return props.width;
    },
    get label() {
      return props.label;
    },
    get side() {
      return props.side;
    },
    size,
    resize: setSize,
  };
  useContext(SplitContext)?.(entry);
  const contextual = useContext(ContextualContext);
  // a column at the top of a workspace tells it what it needs; panes inside this one are not its columns. A context
  // column beside a single main column needs nothing: where there is no room beside, it stands under the main column.
  useContext(ColumnsContext)?.register({
    get need() {
      return props.width ? widthRange(props.width).min : flexibleMin;
    },
    get detail() {
      return props.detail === true;
    },
    get away() {
      return Boolean(props.side) && (contextual?.() ?? false);
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
        "--k2-pane-w": props.width ? `${size() ?? widthRange(props.width).default}px` : undefined,
        "--k2-pane-min": props.width ? `${widthRange(props.width).min}px` : undefined,
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
Pane.Split = (props: {
  /** The panes side by side; a pane that is not there is `undefined`. */
  children: JSX.Element;
}) => {
  const [entries, setEntries] = createSignal<readonly SplitEntry[]>([]);
  const register = (entry: SplitEntry) => {
    setEntries((list) => [...list, entry]);
    onCleanup(() => setEntries((list) => list.filter((other) => other !== entry)));
  };
  // at the top of a workspace that declares a detail: what stands in its place while none is open
  const columns = useContext(ColumnsContext);
  // exactly one main column and one context column after it, and no place of a detail: only then the context gives way
  // (a list, its reader and an info column keep their own columns and scrollers)
  const contextual = () => {
    const [main, context, ...rest] = entries();
    return rest.length === 0 && main !== undefined && !main.side && Boolean(context?.side) && !columns?.empty();
  };
  return (
    <SplitContext.Provider value={register}>
      <ContextualContext.Provider value={contextual}>
        <SplitBody entries={entries()} empty={columns?.empty()} contextual={contextual()}>
          {props.children}
        </SplitBody>
      </ContextualContext.Provider>
    </SplitContext.Provider>
  );
};

/**
 * Renders the panes first (each registers its width), then puts a seam after every pane; the stylesheet hides the one
 * after the last. Panes may come and go (`Show`): each takes its own seam with it, and the grips follow. Every entry
 * of the list is the same two nodes, so nothing in it comes and goes on its own (that would not be removed cleanly
 * after hydration). In the browser a pane's entry is found by its element, on the server by its order.
 */
const SplitBody = (props: {
  entries: readonly SplitEntry[];
  empty: { icon: string; text: string } | undefined;
  /** One main column and one context column after it (see `Pane side`). */
  contextual: boolean;
  children: JSX.Element;
}) => {
  const resolved = resolveChildren(() => props.children);
  // a pane hidden by `Show` or `{open && <Pane …/>}` stays in the list as what renders nothing: it gets no seam
  const panes = () => resolved.toArray().filter((pane) => pane !== undefined && pane !== null && typeof pane !== "boolean" && pane !== "");
  const entryOf = (index: number) => {
    const pane = panes()[index];
    if (pane === undefined) return undefined;
    return props.entries.find((entry) => entry.element !== undefined && entry.element === pane) ?? props.entries[index];
  };
  // The seam after pane `index`: the pane on its right moves it if it has a width, else the pane on its left. The place
  // of a detail that is not open counts as a pane without a width, so the grip stays where it is when it opens.
  const grip = (index: number): SeamGrip | undefined => {
    const left = entryOf(index);
    const right = entryOf(index + 1) ?? (props.empty && index === panes().length - 1 ? {} : undefined);
    if (!right) return undefined;
    const moving = right.width ? right : left?.width ? left : undefined;
    // a column of fixed width has no grip
    const width = moving?.width ? widthRange(moving.width) : undefined;
    if (!moving || !width || width.fixed) return undefined;
    return {
      label: moving.label ?? "Column",
      width,
      value: () => moving.size?.() ?? width.default,
      onChange: (px) => moving.resize?.(px),
      direction: () => (moving === right ? -1 : 1),
      measure: () => {
        const pane = moving.element;
        const split = pane?.parentElement;
        const rendered = pane?.getBoundingClientRect().width;
        if (!pane || !split || !rendered) return undefined;
        // a fixed pane after a line includes it in its width (v2.css)
        const now = rendered + (pane.previousElementSibling?.classList.contains("k2-seam") ? 1 : 0);
        // the flexible panes beside it give way down to their minimum (a pane with a width keeps it)
        let slack = 0;
        for (const other of split.children) if (other.matches(".k2-pane:not([data-width])")) slack += slackOf(other);
        return { now, max: now + slack };
      },
    };
  };
  // The room a context column needs beside its main column: both at their default width (a column without a width at
  // 400 px; the context's default includes the line before it), or the more its `from` asks. The panes registered while
  // they rendered above, so the server's page and the first render in the browser make the same rule.
  const id = createUniqueId();
  const room = () => {
    if (!props.contextual) return undefined;
    const [main, context] = props.entries;
    const both =
      (main?.width ? widthRange(main.width).default : flexibleMin) + (context?.width ? widthRange(context.width).default : flexibleMin);
    return typeof context?.side === "object" ? Math.max(context.side.from, both) : both;
  };
  // Below that room (from 768 px on; the phone stacks every split) the split wraps: the context column and the line
  // before it take a row each, under the main column at the full width, and the split scrolls in one piece, to the end
  // of its content. Above it nothing wraps, whatever width a grip gave a column. The query asks the split's place
  // (`k2-host`: the workspace's main column, or the pane the split stands in), which is as wide as the split; an element
  // cannot ask its own width. The grips' reach (their `::after`) stays inside its line, so the scroller ends at the
  // content. Made per split, as the room is the split's own.
  const split = `.k2-ui .k2-split[data-k2-split="${id}"][data-context]`;
  const flowRule = (px: number) =>
    `@media (min-width: 768px) { @container k2-host (width < ${px}px) { ` +
    `${split} { flex-wrap: wrap; align-content: flex-start; overflow-x: hidden; overflow-y: auto; scrollbar-width: none; } ` +
    `${split}::-webkit-scrollbar { display: none; } ` +
    `${split} > .k2-pane, ${split} > .k2-seam + .k2-pane[data-width] { flex: 0 0 100%; width: auto; min-width: 0; min-height: auto; overflow: visible; } ` +
    `${split} > .k2-pane > .k2-scroll { flex: none; overflow: visible; -webkit-mask-image: none; mask-image: none; animation: none; } ` +
    `${split} > .k2-seam { flex: 0 0 100%; width: auto; height: 1px; } ${split} > .k2-seam > .k2-grip { display: none; } ` +
    // the line across under the main column is the one line there: the last line inside the main column gives way
    `${split} > .k2-pane:first-child > .k2-scroll > :is(.k2-sec, .k2-row):last-child, ` +
    `${split} > .k2-pane:first-child > .k2-scroll > .k2-list:last-child > .k2-row:last-child, ` +
    `${split} > .k2-pane:first-child > .k2-scroll > .k2-table-phone:last-child > .k2-list > .k2-row:last-child { border-bottom: 0; } } }`;
  // The rule stays once it is made, also while a detail stands in the place of the context (the split then drops its
  // `data-context`): no `<style>` comes and goes, so the browser does not restyle the page each time.
  const rule = createMemo<string | undefined>((made) => {
    const px = room();
    return px === undefined ? made : flowRule(px);
  });
  return (
    <>
      <Show when={rule()}>{(text) => <style data-k2-rule="">{text()}</style>}</Show>
      <div
        class="k2-split"
        data-k2-part="Pane.Split"
        data-k2-split={rule() === undefined ? undefined : id}
        data-context={room() === undefined ? undefined : ""}
      >
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
    </>
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
  /** A name for the band, for assistive technology. */
  label?: string;
  /** `Text`, `Row`s, `Prose`, `Tiles` or fields. */
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
  /** A Tabler icon before the label. */
  icon: string;
  /** The data colour of the symbol, such as the colour of an area. */
  color?: string;
  /** What the cell is about, such as "Geld heute". */
  label: string;
  /** The key statement: words, a number or a `Chip`. */
  value: JSX.Element;
  /** A quiet line under the value. */
  meta?: JSX.Element;
  /** The cell leads to this page: a chevron at its end. */
  href?: string;
  /** A short history beside the value, such as orders per day this week (`Spark`). */
  trend?: SparkProps;
  /**
   * The value is on its way: a quiet bar lies on the value and on its quiet line, while symbol and label stay. What is
   * there (a refresh) keeps its exact room unseen under the bar, a quiet line of several lines too; a value not there
   * yet is a bar of one line. So nothing moves when it comes. Assistive technology hears "Wird geladen…" at the value.
   */
  loading?: boolean;
};

/** Two to four equal cells side by side with a line between them; one under the other on the phone. */
export const Cells = (props: {
  /** Two to four `Cells.Cell`. */
  children: JSX.Element;
}) => (
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
      aria-busy={props.loading ? "true" : undefined}
      style={custom({ "--k2-c": props.color })}
    >
      <Icon name={props.icon} />
      <span class="k2-cell-label">
        <RowOpen href={props.href}>{props.label}</RowOpen>
      </span>
      <Show when={props.href} fallback={<span />}>
        <i class="ti ti-chevron-right k2-icon k2-cell-go" aria-hidden="true" />
      </Show>
      <span class="k2-cell-value">
        <Show when={!props.loading} fallback={<PlaceholderValue>{props.value}</PlaceholderValue>}>
          {props.value}
        </Show>
        <Show when={props.trend}>{(trend) => <Spark {...trend()} />}</Show>
      </span>
      <Show when={meta() !== undefined}>
        <span class="k2-cell-meta">
          <Show when={!props.loading} fallback={<PlaceholderValue said={false}>{meta()}</PlaceholderValue>}>
            {meta()}
          </Show>
        </span>
      </Show>
    </div>
  );
};

// ── Tiles ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** A figure on a card, such as "6 Tabellen" or a state such as "8 knapp". */
export type TileStat = {
  /** A Tabler icon before the words. */
  icon?: string;
  /** The figure in words, such as "6 Tabellen". */
  label: string;
  /** A state: its colour, with the words (never a colour alone). */
  status?: Status;
  /** "Waits for you", in the blue of selection, such as "3 Anträge". */
  yours?: boolean;
};

export type Tile = {
  /** A Tabler icon for the kind of thing, such as `file-type-pdf`. */
  icon: string;
  /** The name, such as a file name. */
  title: string;
  /** A quiet line under the name, such as the size or a description. */
  meta?: string;
  /** The tile opens this page or file … */
  href?: string;
  /** … in place on a plain click (see `OnNavigate`). */
  onNavigate?: OnNavigate;
  /** The data colour of the thing: its symbol becomes its mark on a tint of this colour. */
  color?: string;
  /** Cards only: figures and states under the name, such as tables, forms and "8 knapp". */
  stats?: readonly TileStat[];
  /** Cards only: the people at the foot, such as who changed it last (`Avatar.Stack`). */
  people?: readonly Person[];
  /** Cards only: quiet words at the end of the foot, such as "Felix · vor 2 Min". */
  foot?: string;
  /** Cards only: a short history at the top end, in the thing's colour (`Spark`). */
  trend?: SparkProps;
};

/** The last card, which makes a new thing: a dashed frame, its name, and optional quick choices such as templates. */
export type TileCreate = {
  /** What it makes, such as "Neue Base". */
  title: string;
  /** A quiet line, such as "Leer beginnen oder aus einer Vorlage". */
  meta?: string;
  /** The page that makes it … */
  href?: string;
  /** … or the deed. */
  onClick?: () => void;
  /** Quick choices as round chips, such as the templates "CRM" and "Lager". */
  choices?: readonly Action[];
};

/** Like things side by side, such as attachments. Each is pressed, so each is round; never nested. */
export type TilesProps = {
  /** The tiles, in order. */
  items: readonly Tile[];
  /**
   * `card`: each thing a card in a grid (at least 240 px a card), with its mark, figures, people and a short history,
   * such as the bases of Grids or the projects of a team. Without it: small tiles in one wrapping line (attachments).
   */
  variant?: "card";
  /** Cards only: the last card makes a new thing. */
  create?: TileCreate;
  /** One deed after the tiles, such as "Alle herunterladen". */
  more?: Action;
  /** A name for the tiles, for assistive technology. */
  label?: string;
};

const TileName = (props: { tile: Tile }) => (
  <span class="k2-tile-name">
    <span class="k2-tile-title">
      <RowOpen href={props.tile.href} onNavigate={props.tile.onNavigate}>
        {props.tile.title}
      </RowOpen>
    </span>
    <Show when={props.tile.meta}>
      <span class="k2-tile-meta">{props.tile.meta}</span>
    </Show>
  </span>
);

const TileCard = (props: { tile: Tile }) => (
  <div
    class="k2-tile"
    role="listitem"
    data-open={props.tile.href !== undefined ? "" : undefined}
    style={custom({ "--k2-c": props.tile.color })}
  >
    <span class="k2-tile-top">
      <Mark icon={props.tile.icon} color={props.tile.color} />
      <TileName tile={props.tile} />
      <Show when={props.tile.trend}>{(trend) => <Spark {...trend()} />}</Show>
    </span>
    <Show when={props.tile.stats?.length}>
      <span class="k2-tile-stats">
        <For each={props.tile.stats}>
          {(stat) => (
            <span class="k2-tile-stat" data-status={stat.status} data-yours={stat.yours ? "" : undefined}>
              <Show when={stat.icon}>{(name) => <Icon name={name()} />}</Show>
              {stat.label}
            </span>
          )}
        </For>
      </span>
    </Show>
    <Show when={props.tile.people?.length || props.tile.foot}>
      <span class="k2-tile-foot">
        <Show when={props.tile.people?.length}>
          <Avatar.Stack people={props.tile.people ?? []} />
        </Show>
        <Show when={props.tile.foot}>
          <span class="k2-tile-foot-text">{props.tile.foot}</span>
        </Show>
      </span>
    </Show>
  </div>
);

const TileMake = (props: { create: TileCreate }) => (
  <div class="k2-tile" role="listitem" data-create="" data-open={props.create.href !== undefined || props.create.onClick ? "" : undefined}>
    <span class="k2-tile-top">
      <Mark icon="plus" />
      <span class="k2-tile-name">
        <span class="k2-tile-title">
          <RowOpen href={props.create.href} onOpen={props.create.onClick}>
            {props.create.title}
          </RowOpen>
        </span>
        <Show when={props.create.meta}>
          <span class="k2-tile-meta">{props.create.meta}</span>
        </Show>
      </span>
    </span>
    <Show when={props.create.choices?.length}>
      <span class="k2-tile-choices">
        <For each={props.create.choices}>
          {(choice) => (
            <Chip href={choice.href} onNavigate={choice.onNavigate} onClick={choice.onClick} icon={choice.icon}>
              {choice.label}
            </Chip>
          )}
        </For>
      </span>
    </Show>
  </div>
);

export const Tiles = (props: TilesProps) => (
  <div class="k2-tiles" data-k2-part="Tiles" data-variant={props.variant} role="list" aria-label={props.label}>
    <Show
      when={props.variant === "card"}
      fallback={
        <For each={props.items}>
          {(tile) => (
            <div class="k2-tile" role="listitem" data-open={tile.href !== undefined ? "" : undefined}>
              <Show when={tile.color} fallback={<Icon name={tile.icon} />}>
                {(color) => <Mark icon={tile.icon} color={color()} />}
              </Show>
              <TileName tile={tile} />
            </div>
          )}
        </For>
      }
    >
      <For each={props.items}>{(tile) => <TileCard tile={tile} />}</For>
      <Show when={props.create}>{(create) => <TileMake create={create()} />}</Show>
    </Show>
    <Show when={props.more}>{(more) => <ActionButton action={more()} variant="text" />}</Show>
  </div>
);

// ── Canvas ───────────────────────────────────────────────────────────────────────────────────────────────────────

export type CanvasProps = {
  /** What the drawing shows, for assistive technology. */
  label: string;
  /** The height of the drawing in px; the width comes from its place. */
  height?: number;
  /** The drawing: an SVG, a map, a chart of `@k2b/ui`; inside it, CSS is free. */
  children: JSX.Element;
};

/**
 * The one way out: a surface with its own drawing, where an app may write its own CSS. Never measured by the rules.
 * It draws no line of its own; the structure around it separates it, and a drawing that needs an edge draws it.
 * While the drawing loads, has no data or fails, `Loading`, `Empty` or `Failed` stand inside it and keep its height.
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
