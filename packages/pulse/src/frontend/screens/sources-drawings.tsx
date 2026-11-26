import { For, type JSX, Show } from "solid-js";
import type { FetchMinute, FetchSlot } from "../../contracts";

/**
 * The drawings of the sources page, with the exact values of identity study B (Pulse B): the screen places each one
 * in a `Canvas`, the one place where an app draws. They stand in until @k2b/ui has its hero band and Ticks; then the
 * screen swaps the Canvas for the primitive and these go.
 */

/** Pulse's colour and its softer and darker steps, as the study mixes them. */
const PULSE = "#1e40af";
const SOFT = `color-mix(in srgb, ${PULSE} 32%, var(--k2-surface, #fff))`;
const INK = `color-mix(in srgb, ${PULSE} 82%, #000)`;

/** One slot per minute of fetches (study `.ticks`): 3 px wide, 1 px apart; fine 12 px soft, failed 16 px red, none 4 px. */
export const FetchTicksDrawing = (props: { slots: readonly FetchSlot[]; label: string }) => (
  <svg width={props.slots.length * 4 - 1} height="16" viewBox={`0 0 ${props.slots.length * 4 - 1} 16`} role="img" aria-label={props.label}>
    <For each={props.slots}>
      {(slot, index) => (
        <rect
          x={index() * 4}
          y={slot === "bad" ? 0 : slot === "none" ? 6 : 2}
          width="3"
          height={slot === "bad" ? 16 : slot === "none" ? 4 : 12}
          rx="1"
          style={{ fill: slot === "bad" ? "var(--k2-bad-dot)" : slot === "none" ? "var(--k2-n200)" : SOFT }}
        />
      )}
    </For>
  </svg>
);

export type HeroException = {
  tone: "ok" | "bad" | "warn" | "off";
  count: string;
  word: string;
  meta?: string;
  /** The exception leads somewhere, such as the fired alerts. */
  href?: string;
};

/**
 * The hero band (study `.band`): the figure that matters today, beside it today's fetches as one bar per ten minutes
 * (red where one failed) with its caption, and under both the exceptions as "● number word · who".
 */
export function SourcesHeroDrawing(props: {
  figure: string;
  label: string;
  meta: string;
  buckets: readonly { ok: number; failed: number }[];
  start: string;
  caption: string;
  end: string;
  chartLabel: string;
  exceptions: readonly HeroException[];
}) {
  const step = 8;
  const width = () => Math.max(1, props.buckets.length) * step;
  return (
    <div class="pulse-hero">
      <style>{HERO_CSS}</style>
      <div class="pulse-hero-fig">
        <span class="pulse-hero-n">{props.figure}</span>
        <span class="pulse-hero-l">{props.label}</span>
        <span class="pulse-hero-m">{props.meta}</span>
      </div>
      <div class="pulse-hero-chart">
        <svg width="100%" height="44" viewBox={`0 0 ${width()} 44`} preserveAspectRatio="none" role="img" aria-label={props.chartLabel}>
          <For each={props.buckets}>
            {(bucket, index) => (
              <rect
                x={index() * step}
                y={bucket.failed > 0 ? 0 : 6}
                width="6"
                height={bucket.failed > 0 ? 44 : 38}
                rx="1.5"
                style={{ fill: bucket.failed > 0 ? "var(--k2-bad-dot)" : bucket.ok > 0 ? SOFT : "var(--k2-n200)" }}
              />
            )}
          </For>
        </svg>
        <div class="pulse-hero-cap">
          <span>{props.start}</span>
          <span>{props.caption}</span>
          <span>{props.end}</span>
        </div>
      </div>
      <div class="pulse-hero-ex">
        <For each={props.exceptions}>
          {(item): JSX.Element => {
            const parts = (
              <>
                <i class="pulse-hero-dot" data-tone={item.tone} />
                <b>{item.count}</b>
                {item.word}
                <Show when={item.meta}>
                  <span class="pulse-hero-m">{item.meta}</span>
                </Show>
              </>
            );
            return item.href ? (
              <a class="pulse-hero-exr" href={item.href}>
                {parts}
              </a>
            ) : (
              <span class="pulse-hero-exr">{parts}</span>
            );
          }}
        </For>
      </div>
    </div>
  );
}

/**
 * The open source's last hour (study `area` + hourly ticks): values per minute as an area in Pulse's colour, the time
 * since the first failed minute shaded red behind it, under it one tick per minute, then the hour's ends.
 */
export function SourceHourDrawing(props: { minutes: readonly FetchMinute[]; start: string; middle: string; end: string; label: string }) {
  const w = 440;
  const h = 76;
  const n = () => Math.max(2, props.minutes.length);
  const top = () => Math.max(1, ...props.minutes.map((minute) => minute.values));
  const x = (index: number) => (index / (n() - 1)) * w;
  const y = (value: number) => h - 2 - (value / top()) * (h - 6);
  const line = () =>
    props.minutes.map((minute, index) => `${index ? "L" : "M"}${x(index).toFixed(1)},${y(minute.values).toFixed(1)}`).join("");
  // the first minute of the failure that lasts until now, if the hour ends failing
  const cut = () => {
    let first = -1;
    for (let index = props.minutes.length - 1; index >= 0 && props.minutes[index]!.slot === "bad"; index--) first = index;
    return first;
  };
  return (
    <div class="pulse-hour" role="img" aria-label={props.label}>
      <style>{HOUR_CSS}</style>
      <svg width="100%" height={h} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden="true">
        <Show when={cut() >= 0}>
          <rect x={x(cut()).toFixed(1)} y="0" width={(w - x(cut())).toFixed(1)} height={h} style={{ fill: "var(--k2-bad-tint)" }} />
          <line
            x1={x(cut()).toFixed(1)}
            x2={x(cut()).toFixed(1)}
            y1="0"
            y2={h}
            stroke-dasharray="2 2"
            style={{ stroke: "var(--k2-bad-dot)" }}
          />
        </Show>
        <path d={`${line()}L${w},${h}L0,${h}Z`} style={{ fill: PULSE, "fill-opacity": "0.14" }} />
        <path
          d={line()}
          fill="none"
          stroke-width="1.5"
          vector-effect="non-scaling-stroke"
          stroke-linejoin="round"
          style={{ stroke: PULSE }}
        />
      </svg>
      <span class="pulse-hour-ticks" aria-hidden="true">
        <For each={props.minutes}>{(minute) => <i data-slot={minute.slot} />}</For>
      </span>
      <div class="pulse-hour-axis">
        <span>{props.start}</span>
        <span>{props.middle}</span>
        <span>{props.end}</span>
      </div>
    </div>
  );
}

export type FetchLogRow = { time: string; result: string; failed: boolean; duration: string };

/** The newest fetches as a quiet table (study `.logt`): time and duration in monospace, a failure in red. */
export const FetchLogDrawing = (props: { rows: readonly FetchLogRow[]; label: string }) => (
  <table class="pulse-log" aria-label={props.label}>
    <style>{LOG_CSS}</style>
    <tbody>
      <For each={props.rows}>
        {(row) => (
          <tr>
            <td class="pulse-mono">{row.time}</td>
            <td data-failed={row.failed ? "" : undefined}>{row.failed ? `✕ ${row.result}` : row.result}</td>
            <td class="pulse-mono">{row.duration}</td>
          </tr>
        )}
      </For>
    </tbody>
  </table>
);

const HOUR_CSS = `
.pulse-hour{padding:4px var(--k2-edge,20px) 2px}
.pulse-hour svg{display:block}
.pulse-hour-ticks{display:flex;align-items:flex-end;height:14px;margin-top:6px}
.pulse-hour-ticks i{flex:1;margin-right:2px;height:8px;border-radius:1px;background:${SOFT}}
.pulse-hour-ticks i[data-slot=bad]{height:14px;background:var(--k2-bad-dot)}
.pulse-hour-ticks i[data-slot=none]{height:4px;background:var(--k2-n200)}
.pulse-hour-axis{display:flex;justify-content:space-between;font:var(--k2-t-meta);color:var(--k2-subtle);margin-top:4px}
`;

const LOG_CSS = `
.pulse-log{width:100%;border-collapse:collapse;font:var(--k2-t-row)}
.pulse-log td{height:32px;padding:0 8px;border-bottom:1px solid var(--k2-n100);white-space:nowrap;color:var(--k2-muted)}
.pulse-log td:first-child{padding-left:var(--k2-edge,20px)}
.pulse-log td:last-child{padding-right:var(--k2-edge,20px);text-align:right}
.pulse-log tr:last-child td{border-bottom:0}
.pulse-log td[data-failed]{color:var(--k2-bad)}
.pulse-log td:nth-child(2){width:100%;white-space:normal}
.pulse-mono{font-family:var(--k2-font-mono);font-size:12px;letter-spacing:-.01em;font-variant-numeric:tabular-nums}
`;

// study B: .band, .fig, .chart .cap, .ex, .exr; the phone stacks figure, chart and exceptions
const HERO_CSS = `
.pulse-hero{display:grid;grid-template-columns:auto minmax(0,1fr);grid-template-areas:'fig chart' 'ex ex';gap:14px 32px;align-items:end;padding:18px var(--k2-edge,20px) 14px;font:var(--k2-t-body);color:var(--k2-text-2)}
.pulse-hero-fig{grid-area:fig;display:flex;flex-direction:column;gap:2px;min-width:0}
.pulse-hero-n{font:600 30px/34px var(--k2-font);color:${INK};letter-spacing:-.015em;white-space:nowrap;font-variant-numeric:tabular-nums}
.pulse-hero-l{font:var(--k2-t-body);font-weight:500;color:var(--k2-text-2);white-space:nowrap}
.pulse-hero-m{font:var(--k2-t-meta);color:var(--k2-subtle);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pulse-hero-chart{grid-area:chart;min-width:0}
.pulse-hero-chart svg{display:block}
.pulse-hero-cap{font:var(--k2-t-meta);color:var(--k2-subtle);display:flex;justify-content:space-between;gap:12px;margin-top:5px;white-space:nowrap}
.pulse-hero-cap span:nth-child(2){color:var(--k2-muted);overflow:hidden;text-overflow:ellipsis}
.pulse-hero-ex{grid-area:ex;display:flex;flex-wrap:wrap;gap:6px 24px;min-width:0;padding-top:12px;border-top:1px solid var(--k2-n100)}
.pulse-hero-exr{display:flex;align-items:center;gap:8px;white-space:nowrap;color:var(--k2-text-2);min-width:0}
.pulse-hero-exr b{font-weight:600}
.pulse-hero-exr .pulse-hero-m{margin-left:2px}
.pulse-hero-dot{width:7px;height:7px;border-radius:50%;background:var(--k2-ok-dot);flex:none}
.pulse-hero-dot[data-tone=bad]{background:var(--k2-bad-dot)}
.pulse-hero-dot[data-tone=off]{background:var(--k2-n400)}
.pulse-hero-dot[data-tone=warn]{background:var(--k2-warn-dot)}
a.pulse-hero-exr{color:inherit;text-decoration:none;border-radius:4px}
a.pulse-hero-exr:hover b,a.pulse-hero-exr:focus-visible b{text-decoration:underline}
a.pulse-hero-exr:focus-visible{outline:2px solid var(--k2-blue);outline-offset:2px}
@media (max-width:700px){.pulse-hero{grid-template-columns:1fr;grid-template-areas:'fig' 'chart' 'ex';gap:12px;padding:14px var(--k2-edge,16px) 14px}.pulse-hero-ex{gap:6px 14px}.pulse-hero-exr{white-space:normal}}
`;
