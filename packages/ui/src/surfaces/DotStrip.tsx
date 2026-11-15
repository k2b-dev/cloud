import { createEffect, createSignal, For, type JSX, on, Show } from "solid-js";

/**
 * `accent` = the app colour (it worked), `ai` = came from AI, `muted` = nothing happened. Run outcomes: `success` worked,
 * `danger` failed, `skipped` did not start, `running` runs right now, `planned` starts later.
 */
export type DotStripTone = "accent" | "warning" | "danger" | "ai" | "muted" | "success" | "skipped" | "running" | "planned";

export type DotStripProps = {
  /** Outcomes in order, left to right. */
  dots: readonly DotStripTone[];
  /** Total slots. Slots after `dots` show as empty rings, so a growing strip keeps its size. Defaults to `dots.length`. */
  length?: number;
  /** Shows every slot as a quiet placeholder, for "nothing checked yet". */
  waiting?: boolean;
  /** Index of the dot that belongs to the item shown next to the strip. */
  selected?: number | null;
  size?: "md" | "lg";
  /**
   * `dot` draws round dots; `bar` draws upright bars, as a run history does. In both, form carries the state as well as
   * colour: a failed bar is interrupted, a skipped or planned one is short, a running one is a ring.
   */
  shape?: "dot" | "bar";
  /** Dots per row; more wrap into further rows of the same width. Defaults to one row. */
  columns?: number;
  /** Names the strip and its counts, for example "Last 50 mails: 17 matched, 6 skipped, 27 not". */
  label: string;
  /** Opens the item behind each slot, such as one run; a slot without one stays a plain mark. */
  hrefs?: readonly (string | undefined)[];
  /** Names each slot for a link or tooltip, such as "Run at 13:45: failed". */
  labels?: readonly string[];
  class?: string;
};

/** States that end a run: a slot that reaches one of them from `running` settles with one short spring. */
const SETTLED = new Set(["success", "danger", "skipped", "accent", "warning", "muted"]);

function Slot(props: { state: string; selected: boolean; href?: string; label?: string }) {
  // Only a change seen in the browser animates; the first render, on the server or after hydration, stands still.
  const [settled, setSettled] = createSignal(false);
  createEffect(
    on(
      () => props.state,
      (state, previous) => setSettled(previous === "running" && SETTLED.has(state)),
      { defer: true },
    ),
  );
  const mark = () => (
    // The AI tone carries its own `-ai` class: the AI palette stays with AI surfaces (F3).
    <i
      class={
        props.state === "ai"
          ? "k2b-dot-strip__dot k2b-dot-strip__dot-ai"
          : props.state === "running"
            ? "k2b-dot-strip__dot k2b-dot-strip__live-ai"
            : "k2b-dot-strip__dot"
      }
      data-state={props.state}
      data-selected={props.selected ? "" : undefined}
      data-settled={settled() ? "" : undefined}
    />
  );
  return (
    <Show when={props.href} fallback={mark()}>
      {(href) => (
        <a class="k2b-dot-strip__link" role="listitem" href={href()} aria-label={props.label} title={props.label}>
          {mark()}
        </a>
      )}
    </Show>
  );
}

/** A fixed-size row of outcome dots or bars: the last runs, checks or mails at a glance. */
export function DotStrip(props: DotStripProps): JSX.Element {
  const length = () => Math.max(props.length ?? props.dots.length, props.dots.length);
  const slots = () => Array.from({ length: length() }, (_, index) => index);
  const state = (index: number) => {
    if (props.waiting) return "waiting";
    return props.dots[index] ?? "pending";
  };
  const linked = () => Boolean(props.hrefs?.some(Boolean));
  const shared = () => ({
    class: `k2b-dot-strip ${props.class ?? ""}`,
    "data-size": props.size ?? "md",
    "data-shape": props.shape ?? "dot",
    "aria-label": props.label,
    style: { "--k2b-dot-strip-columns": String(props.columns ?? length()) },
  });
  const slotsView = () => (
    <For each={slots()}>
      {(index) => (
        <Slot
          state={state(index)}
          selected={props.selected === index}
          href={props.waiting ? undefined : props.hrefs?.[index]}
          label={props.labels?.[index]}
        />
      )}
    </For>
  );
  // Linked slots are a list of links; otherwise the strip is one image with one name.
  return (
    <Show
      when={linked()}
      fallback={
        <div {...shared()} role="img">
          {slotsView()}
        </div>
      }
    >
      <div {...shared()} role="list">
        {slotsView()}
      </div>
    </Show>
  );
}

export default DotStrip;
