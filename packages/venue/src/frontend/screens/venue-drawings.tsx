import { For, type JSX, Show } from "solid-js";

/**
 * The hero band of a Venue page with the values of identity study B (`.band`): the screen places it in a `Canvas`,
 * the one place where an app draws, until @k2b/ui has its hero band; then the screen swaps the Canvas for it.
 */

export type HeroException = { tone: "ok" | "bad" | "warn" | "off"; count: string; word: string; meta?: string };

/**
 * The figure that matters, in the colour of whose it is (the venue's accent), beside it its real trend (a chart the
 * screen hands in), and under both the exceptions as "● number word · who".
 */
export function VenueHeroDrawing(props: {
  figure: string;
  label: string;
  meta?: string;
  /** The venue's accent colour, for the figure. */
  color: string;
  chart?: JSX.Element;
  exceptions: readonly HeroException[];
}) {
  return (
    <div class="venue-hero" style={{ "--venue-app": props.color }}>
      <style>{HERO_CSS}</style>
      <div class="venue-hero-fig">
        <span class="venue-hero-n">{props.figure}</span>
        <span class="venue-hero-l">{props.label}</span>
        <Show when={props.meta}>
          <span class="venue-hero-m">{props.meta}</span>
        </Show>
      </div>
      <div class="venue-hero-chart">{props.chart}</div>
      <Show when={props.exceptions.length > 0}>
        <div class="venue-hero-ex">
          <For each={props.exceptions}>
            {(item) => (
              <span class="venue-hero-exr">
                <i class="venue-hero-dot" data-tone={item.tone} />
                <b>{item.count}</b>
                {item.word}
                <Show when={item.meta}>
                  <span class="venue-hero-m">{item.meta}</span>
                </Show>
              </span>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}

/**
 * How full a shift is: a bar against its target, amber while people are missing (one state, one colour), neutral once
 * it is covered, with the words beside it.
 */
export const StaffingMeterDrawing = (props: { assigned: number; target: number; missing: boolean; words: string }) => {
  const share = () => (props.target > 0 ? Math.min(1, props.assigned / props.target) : 1);
  return (
    <span class="venue-meter">
      <style>{METER_CSS}</style>
      <svg width="96" height="6" viewBox="0 0 96 6" aria-hidden="true">
        <rect x="0" y="0" width="96" height="6" rx="3" style={{ fill: "var(--k2-n100)" }} />
        <rect
          x="0"
          y="0"
          width={(share() * 96).toFixed(1)}
          height="6"
          rx="3"
          style={{ fill: props.missing ? "var(--k2-warn-dot)" : "var(--k2-n400)" }}
        />
      </svg>
      <span data-missing={props.missing ? "" : undefined}>{props.words}</span>
    </span>
  );
};

/**
 * One shift in the calendar (identity B): its name in 600, its people under it, and a gap in amber only where one is;
 * a covered shift says nothing about its staffing.
 */
export const ShiftBlockDrawing = (props: { title: string; gap?: string; people?: string; compact: boolean }) => (
  <span class="venue-shift" data-compact={props.compact ? "" : undefined}>
    <style>{SHIFT_CSS}</style>
    <b>{props.title}</b>
    <Show when={props.gap}>
      <span class="venue-shift-gap">● {props.gap}</span>
    </Show>
    <Show when={!props.compact && props.people}>
      <span class="venue-shift-people">{props.people}</span>
    </Show>
  </span>
);

const SHIFT_CSS = `
.venue-shift{display:flex;flex-direction:column;gap:1px;min-width:0;font:var(--k2-t-meta)}
.venue-shift b{font:600 13px/18px var(--k2-font);color:var(--k2-text);overflow:hidden;text-overflow:ellipsis}
.venue-shift-gap{color:var(--k2-warn);font-weight:500}
.venue-shift-people{color:var(--k2-subtle);overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical}
.venue-shift[data-compact]{flex-direction:row;gap:6px}
`;

const METER_CSS = `
.venue-meter{display:inline-flex;align-items:center;gap:10px;min-width:0}
.venue-meter svg{flex:none}
.venue-meter span[data-missing]{color:var(--k2-warn);font-weight:500}
`;

// study B: .band, .fig, .ex, .exr; the phone stacks figure, chart and exceptions
const HERO_CSS = `
.venue-hero{display:grid;grid-template-columns:auto minmax(0,1fr);grid-template-areas:'fig chart' 'ex ex';gap:14px 32px;align-items:end;padding:18px var(--k2-edge,20px) 14px;font:var(--k2-t-body);color:var(--k2-text-2)}
.venue-hero-fig{grid-area:fig;display:flex;flex-direction:column;gap:2px;min-width:0}
.venue-hero-n{font:600 30px/34px var(--k2-font);color:color-mix(in srgb,var(--venue-app) 82%,#000);letter-spacing:-.015em;white-space:nowrap;font-variant-numeric:tabular-nums}
.venue-hero-l{font:var(--k2-t-body);font-weight:500;color:var(--k2-text-2);white-space:nowrap}
.venue-hero-m{font:var(--k2-t-meta);color:var(--k2-subtle);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:32ch}
.venue-hero-chart{grid-area:chart;min-width:0;height:96px}
.venue-hero .stdlib-chart{--stdlib-chart-c1:var(--venue-app)}
.venue-hero-ex{grid-area:ex;display:flex;flex-wrap:wrap;gap:6px 24px;min-width:0;padding-top:12px;border-top:1px solid var(--k2-n100)}
.venue-hero-exr{display:flex;align-items:center;gap:8px;white-space:nowrap;color:var(--k2-text-2);min-width:0}
.venue-hero-exr b{font-weight:600}
.venue-hero-exr .venue-hero-m{margin-left:2px}
.venue-hero-dot{width:7px;height:7px;border-radius:50%;background:var(--k2-n400);flex:none}
.venue-hero-dot[data-tone=ok]{background:var(--k2-ok-dot)}
.venue-hero-dot[data-tone=bad]{background:var(--k2-bad-dot)}
.venue-hero-dot[data-tone=warn]{background:var(--k2-warn-dot)}
@media (max-width:700px){.venue-hero{grid-template-columns:1fr;grid-template-areas:'fig' 'chart' 'ex';gap:12px;padding:14px var(--k2-edge,16px) 14px}.venue-hero-ex{gap:6px 14px}.venue-hero-exr{white-space:normal}}
`;
