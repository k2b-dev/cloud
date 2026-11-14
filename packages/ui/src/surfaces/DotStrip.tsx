import { For, type JSX, Show } from "solid-js";

/**
 * `accent` = the app colour (it worked), `success` = it worked, in the success colour, `ai` = came from AI,
 * `warning` and `danger` = it needs a look or failed, `muted` = nothing happened (skipped), `running` = runs now.
 */
export type DotStripTone = "accent" | "success" | "warning" | "danger" | "ai" | "muted" | "running";

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
   * `dot`, the default: round marks whose shape follows the state, so colour is never the only sign (a circle when it
   * worked, a diamond when it needs a look or failed, a ring when nothing happened). `bar`: upright bars, 5 × 22 px at
   * `lg`, as for the last runs beside a time; a failed run is red and broken, a skipped one short. `slot`: square
   * places, as for the places of a runner.
   */
  variant?: "dot" | "bar" | "slot";
  /** Dots per row; more wrap into further rows of the same width. Defaults to one row. */
  columns?: number;
  /** Names the strip and its counts, for example "Last 50 mails: 17 matched, 6 skipped, 27 not". */
  label: string;
  /**
   * One link per dot, such as the run it stands for; a dot without a link stays a mark. With links every dot is a
   * list item and needs its name in `dotLabels`.
   */
  links?: readonly (string | undefined)[];
  /** One accessible name per dot, such as "Run at 14:01: failed". Required with `links`. */
  dotLabels?: readonly string[];
  class?: string;
};

type DotState = DotStripTone | "pending" | "waiting";

/** A fixed-size row of outcome marks: the last runs, checks or mails at a glance, each optionally a link. */
export function DotStrip(props: DotStripProps): JSX.Element {
  const length = () => Math.max(props.length ?? props.dots.length, props.dots.length);
  const slots = () => Array.from({ length: length() }, (_, index) => index);
  const state = (index: number): DotState => {
    if (props.waiting) return "waiting";
    return props.dots[index] ?? "pending";
  };
  const linked = () => Boolean(props.links?.length);
  const mark = (index: number) => (
    // The AI tones carry their own `-ai` class: the AI palette stays with AI surfaces (F3).
    <i
      class={state(index) === "ai" || state(index) === "running" ? "k2b-dot-strip__dot k2b-dot-strip__dot-ai" : "k2b-dot-strip__dot"}
      data-state={state(index)}
      data-selected={props.selected === index ? "" : undefined}
    />
  );
  return (
    <div
      class={`k2b-dot-strip ${props.class ?? ""}`}
      data-size={props.size ?? "md"}
      data-variant={props.variant ?? "dot"}
      {...{ role: linked() ? "list" : "img", "aria-label": props.label }}
      style={{ "--k2b-dot-strip-columns": String(props.columns ?? length()) }}
    >
      <For each={slots()}>
        {(index) => (
          <Show when={linked()} fallback={mark(index)}>
            <Show
              when={props.links?.[index]}
              fallback={
                <span class="k2b-dot-strip__place" role="listitem" aria-label={props.dotLabels?.[index]}>
                  {mark(index)}
                </span>
              }
            >
              {(href) => (
                <a class="k2b-dot-strip__place" role="listitem" href={href()} aria-label={props.dotLabels?.[index]}>
                  {mark(index)}
                </a>
              )}
            </Show>
          </Show>
        )}
      </For>
    </div>
  );
}

export default DotStrip;
