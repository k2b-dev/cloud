import { For, type JSX } from "solid-js";

/** `accent` = the app colour (it worked), `ai` = came from AI, `muted` = nothing happened. */
export type DotStripTone = "accent" | "warning" | "danger" | "ai" | "muted";

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
  /** Dots per row; more wrap into further rows of the same width. Defaults to one row. */
  columns?: number;
  /** Names the strip and its counts, for example "Last 50 mails: 17 matched, 6 skipped, 27 not". */
  label: string;
  class?: string;
};

/** A fixed-size row of outcome dots: the last runs, checks or mails at a glance. */
export function DotStrip(props: DotStripProps): JSX.Element {
  const length = () => Math.max(props.length ?? props.dots.length, props.dots.length);
  const slots = () => Array.from({ length: length() }, (_, index) => index);
  const state = (index: number) => {
    if (props.waiting) return "waiting";
    return props.dots[index] ?? "pending";
  };
  return (
    <div
      class={`k2b-dot-strip ${props.class ?? ""}`}
      data-size={props.size ?? "md"}
      role="img"
      aria-label={props.label}
      style={{ "--k2b-dot-strip-columns": String(props.columns ?? length()) }}
    >
      <For each={slots()}>
        {(index) => (
          // The AI tone carries its own `-ai` class: the AI palette stays with AI surfaces (F3).
          <i
            class={state(index) === "ai" ? "k2b-dot-strip__dot k2b-dot-strip__dot-ai" : "k2b-dot-strip__dot"}
            data-state={state(index)}
            data-selected={props.selected === index ? "" : undefined}
          />
        )}
      </For>
    </div>
  );
}

export default DotStrip;
