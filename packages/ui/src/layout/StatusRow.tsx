import { createEffect, createSignal, createUniqueId, For, type JSX, onCleanup, onMount, Show } from "solid-js";
import { Button } from "../actions/Button";
import { useWorkspaceMessages } from "./workspace-messages";

/** A key figure of the status row: the number (bold) and what it counts. */
export type StatusRowFact = { value: JSX.Element; label: JSX.Element };

/** A page-wide disturbance that needs nobody: the page tries again by itself (K10). */
export type StatusRowState = {
  /** What is wrong, in a few words, such as "Sync paused". */
  label: JSX.Element;
  /** `warning` (the default) or `danger`; `neutral` for a quiet state such as "Offline". */
  tone?: "neutral" | "warning" | "danger";
  /** Tabler icon class inside the round sign, such as `ti ti-refresh`. Defaults to an alert sign. */
  icon?: string;
  /** The time of the next attempt as people read it, such as "14:05". Shows as "next attempt 14:05". */
  next?: JSX.Element;
};

/** A selection in the list below: its count becomes the lead statement, its figures and actions take the places of the key figures and filters (K6). */
export type StatusRowSelection = {
  /** The number of chosen items. A check and "3 selected" take the lead statement's place. */
  count: number;
  /** Up to three figures about the chosen items, such as their kinds or total size. */
  facts?: readonly StatusRowFact[];
  /** Actions on the chosen items, usually small buttons. */
  actions?: JSX.Element;
};

export type StatusRowProps = {
  /** The lead statement (18 px, bold): what someone wants to know here first. It is never shortened. */
  lead: JSX.Element;
  /** Up to three key figures. Only the first three show; the rest give way in a fixed order when space is short. */
  facts?: readonly StatusRowFact[];
  /**
   * Filters at the end of the row, usually `FilterChip` elements (up to 36 px tall). From 768 px they stay on one
   * line: those that do not fit fold behind "Filters +n", which opens them below the row. A phone scrolls them
   * sideways with a fade at the edge where they continue.
   */
  filters?: JSX.Element;
  /** A disturbance of the whole page; it takes the place of the key figures, the lead statement stays. */
  state?: StatusRowState;
  /** A selection; its count and actions take the place of the key figures and filters. */
  selection?: StatusRowSelection;
  /**
   * What is happening right now in words, announced politely to screen readers and shown in the place of the key
   * figures, such as "Moving “Invoice 12” to Done". Drag and drop fills it while an item moves (K7).
   */
  announcement?: JSX.Element;
  /** A hairline under the row, where the row stands above a list without its own column head. */
  line?: boolean;
  class?: string;
};

const present = (value: unknown) => value !== undefined && value !== null && value !== false && value !== "";

/** A filter group that a fold already watches, so a second call only folds again. */
type WatchedFilters = HTMLElement & { __k2bStatusFilters?: { schedule: () => void; dispose: () => void } };

/**
 * Self-contained: the server embeds it right after the filters, so it runs before hydration and on pages that never
 * hydrate them; the component calls it again on mount. The filters wrap inside one line's height; whatever wraps
 * past the first line folds: it hides, and "Filters +n" counts it. It folds again whenever the row or a filter
 * changes size, never while the folded filters are open. On a phone the filters do not wrap, so nothing folds.
 */
function watchStatusFilters(element: Element | null) {
  if (!(element instanceof HTMLElement) || typeof ResizeObserver === "undefined") return;
  const end = element as WatchedFilters;
  if (end.__k2bStatusFilters) {
    end.__k2bStatusFilters.schedule();
    return end.__k2bStatusFilters;
  }
  const group = end.querySelector<HTMLElement>(":scope > .k2b-status-row__filters");
  const more = end.querySelector<HTMLElement>(":scope > .k2b-status-row__more");
  if (!group || !more) return;
  // The box a filter draws: an island wrapper draws none, its first element does.
  const box = (item: Element): Element =>
    getComputedStyle(item).display === "contents" && item.firstElementChild ? box(item.firstElementChild) : item;
  const settle = () => {
    if (group.hasAttribute("data-open")) return;
    const items = Array.from(group.children);
    for (const item of items) item.removeAttribute("data-fit-hidden");
    more.hidden = true;
    if (items.length === 0 || getComputedStyle(group).flexWrap !== "wrap") return;
    const wrapped = () => {
      const top = box(items[0]!).getBoundingClientRect().top;
      return items.filter((item) => box(item).getBoundingClientRect().top > top + 1);
    };
    if (wrapped().length === 0) return;
    // The button takes room from the line, so more may wrap once it shows.
    more.hidden = false;
    const folded = wrapped();
    for (const item of folded) item.setAttribute("data-fit-hidden", "");
    const count = more.querySelector(".k2b-status-row__more-count");
    if (count) count.textContent = `+${folded.length}`;
  };
  let frame = 0;
  const schedule = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(settle);
  };
  const resize = new ResizeObserver(schedule);
  const observe = () => {
    resize.disconnect();
    if (end.parentElement) resize.observe(end.parentElement);
    for (const item of Array.from(group.children)) resize.observe(box(item));
    schedule();
  };
  // A filter that comes or goes changes the line.
  const children = new MutationObserver(observe);
  children.observe(group, { childList: true });
  const watch = {
    schedule,
    dispose: () => {
      resize.disconnect();
      children.disconnect();
      cancelAnimationFrame(frame);
      Reflect.deleteProperty(end, "__k2bStatusFilters");
    },
  };
  end.__k2bStatusFilters = watch;
  observe();
  return watch;
}
const STATUS_FILTERS_SCRIPT = `(${watchStatusFilters})(document.currentScript&&document.currentScript.previousElementSibling)`;

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])';

/**
 * The filters at the end of the row. From 768 px they never scroll: those that do not fit fold behind
 * "Filters +n", which opens the same filters, with their state, in a panel that grows below the row; the row moves
 * nothing. Escape, a press outside, or focus leaving closes it and returns focus to the button.
 */
function StatusRowFilters(props: { children: JSX.Element }): JSX.Element {
  const messages = useWorkspaceMessages();
  const id = `k2b-status-filters-${createUniqueId()}`;
  const [open, setOpen] = createSignal(false);
  let end: HTMLDivElement | undefined;
  let group: HTMLDivElement | undefined;
  let button: HTMLButtonElement | undefined;
  onMount(() => {
    const watch = watchStatusFilters(end ?? null);
    onCleanup(() => watch?.dispose());
  });
  const close = (returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) button?.focus();
    (end as WatchedFilters | undefined)?.__k2bStatusFilters?.schedule();
  };
  createEffect(() => {
    if (!open() || !end) return;
    const root = end;
    // The first filter that waited takes focus, so the keyboard continues where the eye goes.
    root
      .querySelector<HTMLElement>(
        `.k2b-status-row__filters > [data-fit-hidden] :is(${FOCUSABLE}), .k2b-status-row__filters > [data-fit-hidden]:is(${FOCUSABLE})`,
      )
      ?.focus();
    const press = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.contains(event.target)) close(false);
    };
    const key = (event: KeyboardEvent) => {
      // A filter's own open menu closes first.
      if (event.key !== "Escape" || event.defaultPrevented || group?.querySelector(":popover-open")) return;
      event.preventDefault();
      close(true);
    };
    const leave = (event: FocusEvent) => {
      if (event.relatedTarget instanceof Node && !root.contains(event.relatedTarget)) close(false);
    };
    document.addEventListener("pointerdown", press, true);
    root.addEventListener("keydown", key);
    root.addEventListener("focusout", leave);
    onCleanup(() => {
      document.removeEventListener("pointerdown", press, true);
      root.removeEventListener("keydown", key);
      root.removeEventListener("focusout", leave);
    });
  });
  return (
    <>
      <div ref={end} class="k2b-status-row__end" data-filters="">
        <div ref={group} id={id} class="k2b-status-row__filters" data-open={open() ? "" : undefined}>
          {props.children}
        </div>
        <span class="k2b-status-row__more" hidden>
          <Button
            ref={button}
            size="sm"
            variant="secondary"
            aria-expanded={open() ? "true" : "false"}
            aria-controls={id}
            onClick={() => (open() ? close(true) : setOpen(true))}
          >
            {messages().statusFilters} <span class="k2b-status-row__more-count">+0</span>
          </Button>
        </span>
      </div>
      <script innerHTML={STATUS_FILTERS_SCRIPT} />
    </>
  );
}

/** The state's hint in words, when its label and time are plain text: what is wrong and the next attempt. */
const stateHint = (state: StatusRowState, nextAttempt: string): string | undefined => {
  const label = state.label;
  const next = state.next;
  if (typeof label !== "string") return undefined;
  if (!present(next)) return label;
  return typeof next === "string" ? `${label} · ${nextAttempt} ${next}` : undefined;
};

/**
 * The status row (K6, K10): the first line under a column's head, 52 px tall. The lead statement on the left keeps
 * its place and size in every state. Up to three key figures follow it; on the right stand the filters. A selection
 * shows its count and actions in the same places; a disturbance of the page shows a round sign, what is wrong, and
 * the next attempt in the place of the key figures. It shows only data that exists already.
 */
export function StatusRow(props: StatusRowProps): JSX.Element {
  const messages = useWorkspaceMessages();
  const mode = () => (props.selection ? "selection" : present(props.announcement) ? "announcement" : props.state ? "state" : "facts");
  return (
    <div
      class={`k2b-status-row${props.class ? ` ${props.class}` : ""}`}
      data-mode={mode()}
      data-tone={mode() === "state" ? (props.state?.tone ?? "warning") : undefined}
      data-line={props.line ? "" : undefined}
    >
      <p class="k2b-status-row__lead">
        <Show when={props.selection} fallback={props.lead}>
          {(selection) => (
            <>
              <i class="ti ti-check" aria-hidden="true" /> {messages().statusSelected({ count: selection().count })}
            </>
          )}
        </Show>
      </p>
      <div class="k2b-status-row__middle">
        <Show when={mode() === "facts" || mode() === "selection"}>
          <For each={((mode() === "selection" ? props.selection?.facts : props.facts) ?? []).slice(0, 3)}>
            {(fact) => (
              <span class="k2b-status-row__fact">
                <b>{fact.value}</b> {fact.label}
              </span>
            )}
          </For>
        </Show>
        <Show when={mode() === "state" && props.state}>
          {(state) => (
            <span
              class="k2b-status-row__state"
              // The whole state stays readable when its label shortens (K15): the hint carries it with its time.
              title={stateHint(state(), messages().statusNextAttempt)}
            >
              <span class="k2b-status-row__sign" aria-hidden="true">
                <i class={state().icon ?? "ti ti-alert-triangle"} />
              </span>
              <b>{state().label}</b>
              <Show when={present(state().next)}>
                <span class="k2b-status-row__next">
                  <span class="k2b-status-row__next-label">{messages().statusNextAttempt}</span>
                  <time class="k2b-status-row__time">{state().next}</time>
                </span>
              </Show>
            </span>
          )}
        </Show>
        <Show when={mode() === "announcement"}>
          <span class="k2b-status-row__announcement">{props.announcement}</span>
        </Show>
      </div>
      <Show when={mode() === "selection" && present(props.selection?.actions)}>
        <div class="k2b-status-row__end">{props.selection?.actions}</div>
      </Show>
      <Show when={mode() !== "selection" && present(props.filters)}>
        <StatusRowFilters>{props.filters}</StatusRowFilters>
      </Show>
      {/* The live region exists from the first frame, so the first announcement is heard. */}
      <span class="k2b-sr-only" aria-live="polite" aria-atomic="true">
        {props.announcement}
      </span>
    </div>
  );
}

export default StatusRow;
