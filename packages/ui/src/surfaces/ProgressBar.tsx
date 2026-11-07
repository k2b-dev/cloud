import { For, type JSX, Show } from "solid-js";
import type { IntentTone } from "../semantics";

export type ProgressBarTone = Extract<IntentTone, "info" | "success" | "warning" | "danger">;

/** One part of a segmented bar, in the unit of `limit`. `"hatched"` marks an expected, not yet booked part. */
export type ProgressBarSegment = { value: number; pattern?: "solid" | "hatched" };

export type ProgressBarProps = {
  /** Percent from 0 to 100. With `segments`, the share of `limit` the segments fill. */
  value?: number;
  size?: "xs" | "sm" | "md";
  tone?: ProgressBarTone;
  showValue?: boolean;
  label: string;
  /** Parts drawn in order, such as booked and expected spending. Negative and non-finite values count as 0. */
  segments?: readonly ProgressBarSegment[];
  /** The budget the segments fill. What goes beyond it is drawn red, with a mark at the limit. */
  limit?: number;
  /** Spoken value, such as "1,240 € of 1,500 €"; defaults to the percent. */
  valueText?: string;
  class?: string;
};

export type ProgressBarPart = { pattern: "solid" | "hatched" | "over"; width: number };

/**
 * Sum minus limit, without float residue: `0.1 + 0.2` against `0.3` is not over. Amounts within a billionth of the
 * larger of both count as equal.
 */
export const budgetOverrun = (total: number, limit: number): number => {
  const over = total - limit;
  return over > Math.max(1, Math.abs(total), Math.abs(limit)) * 1e-9 ? over : 0;
};

/** Sum over limit; an empty budget with spending is infinitely full. */
export const budgetRatio = (total: number, limit: number): number => (limit > 0 ? total / limit : total > 0 ? Number.POSITIVE_INFINITY : 0);

/**
 * The drawn parts of a segmented bar, each as a percent of the track. The track spans the larger of the limit and the
 * sum, so an overrun stays visible: segments fill up to the limit in order, the rest is one "over" part, and `mark`
 * places the limit line (only when the sum goes beyond it). Without `limit` the segments fill the track; a limit of 0,
 * below 0 or not finite is an empty budget, so any spending is over it.
 */
export const progressBarParts = (
  segments: readonly ProgressBarSegment[],
  limit?: number,
): { parts: ProgressBarPart[]; total: number; over: number; mark: number | null; ratio: number } => {
  const values = segments.map((segment) => ({
    pattern: segment.pattern ?? "solid",
    value: Number.isFinite(segment.value) ? Math.max(0, segment.value) : 0,
  }));
  const total = values.reduce((sum, segment) => sum + segment.value, 0);
  const budget = limit === undefined ? total : Number.isFinite(limit) ? Math.max(0, limit) : 0;
  const scale = Math.max(budget, total);
  if (scale <= 0) return { parts: [], total, over: 0, mark: null, ratio: 0 };
  const parts: ProgressBarPart[] = [];
  let filled = 0;
  for (const segment of values) {
    const inside = Math.max(0, Math.min(segment.value, budget - filled));
    if (inside > 0) parts.push({ pattern: segment.pattern, width: (inside / scale) * 100 });
    filled += segment.value;
  }
  const over = budgetOverrun(total, budget);
  if (over > 0) parts.push({ pattern: "over", width: (over / scale) * 100 });
  return { parts, total, over, mark: over > 0 ? (budget / scale) * 100 : null, ratio: budgetRatio(total, budget) };
};

const clamp = (value: number) => (Number.isFinite(value) ? Math.max(0, Math.min(100, Math.round(value))) : 0);

export function ProgressBar(props: ProgressBarProps): JSX.Element {
  const segmented = () => (props.segments ? progressBarParts(props.segments, props.limit) : null);
  // With segments the share always comes from them; `value` only drives the plain bar.
  const percent = () => {
    const bar = segmented();
    if (!bar) return clamp(props.value ?? 0);
    return Number.isFinite(bar.ratio) ? Math.max(0, Math.round(bar.ratio * 100)) : null;
  };
  const shown = () => percent() ?? 100;
  return (
    <div
      class={`k2b-progress ${props.class ?? ""}`}
      data-size={props.size ?? "md"}
      data-tone={props.tone ?? "info"}
      data-segmented={segmented() ? "" : undefined}
    >
      <div
        class="k2b-progress__track"
        role="progressbar"
        aria-label={props.label}
        aria-valuemin="0"
        aria-valuemax="100"
        aria-valuenow={Math.min(100, shown())}
        aria-valuetext={props.valueText ?? (segmented() ? (percent() === null ? "∞" : `${percent()}%`) : undefined)}
      >
        <Show when={segmented()} fallback={<div class="k2b-progress__value" style={`width: ${shown()}%`} />}>
          {(bar) => (
            <>
              <For each={bar().parts}>
                {(part) => <div class="k2b-progress__segment" data-pattern={part.pattern} style={`width: ${part.width.toFixed(3)}%`} />}
              </For>
              <Show when={bar().mark !== null}>
                <span class="k2b-progress__limit" aria-hidden="true" style={`left: ${(bar().mark ?? 0).toFixed(3)}%`} />
              </Show>
            </>
          )}
        </Show>
      </div>
      {props.showValue ? <span class="k2b-progress__percent">{percent() === null ? "∞" : `${percent()}%`}</span> : null}
    </div>
  );
}

export default ProgressBar;
