import { type JSX, Show } from "solid-js";
import type { IntentTone } from "../semantics";

export type ProgressRingTone = Extract<IntentTone, "info" | "warning" | "danger">;

export type ProgressRingProps = {
  value: number;
  tone?: ProgressRingTone;
  /** Names the ring as a progressbar. Omit it inside a control that already carries the name and value. */
  label?: string;
  class?: string;
};

const clamp = (value: number) => (Number.isFinite(value) ? Math.max(0, Math.min(100, Math.round(value))) : 0);

/** Compact determinate ring without a number. Warning and danger add a centre mark, so tone is never colour alone. */
export function ProgressRing(props: ProgressRingProps): JSX.Element {
  const percent = () => clamp(props.value);
  const tone = () => props.tone ?? "info";
  const shapes = () => (
    <>
      <circle class="k2b-progress-ring__track" cx="8" cy="8" r="6" stroke-width="2.5" />
      <circle
        class="k2b-progress-ring__value"
        cx="8"
        cy="8"
        r="6"
        stroke-width="2.5"
        pathLength="100"
        stroke-dasharray={`${percent()} 100`}
        transform="rotate(-90 8 8)"
      />
      {tone() === "warning" ? <circle class="k2b-progress-ring__mark" cx="8" cy="8" r="1.75" /> : null}
      {tone() === "danger" ? <path class="k2b-progress-ring__mark" d="M7.25 4.75h1.5v4h-1.5zM7.25 9.75h1.5v1.5h-1.5z" /> : null}
    </>
  );
  const className = () => `k2b-progress-ring ${props.class ?? ""}`;
  return (
    <Show
      when={props.label}
      fallback={
        <svg class={className()} data-tone={tone()} viewBox="0 0 16 16" fill="none" aria-hidden="true">
          {shapes()}
        </svg>
      }
    >
      {(label) => (
        <svg
          class={className()}
          data-tone={tone()}
          viewBox="0 0 16 16"
          fill="none"
          role="progressbar"
          aria-label={label()}
          aria-valuemin="0"
          aria-valuemax="100"
          aria-valuenow={percent()}
        >
          {shapes()}
        </svg>
      )}
    </Show>
  );
}

export default ProgressRing;
