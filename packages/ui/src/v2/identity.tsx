import { createMemo, For, type JSX, children as resolveChildren, Show, useContext } from "solid-js";
import { Dot, Icon, Mark, type MarkProps, type TickState, Ticks, type TicksProps } from "./marks";
import { PaneHeadContext } from "./pane-head";
import type { Status } from "./types";

// ── Hero ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** At most this many values of a history are drawn: the newest. An app with a longer history sums it up first (per hour, per day). */
const TREND_VALUES = 120;

type TrendWords = {
  /** What the drawing says, in one sentence a person who cannot see it gets the same from. */
  label: string;
  /** What stands in the drawing's place while there is no history, such as "Noch keine Verbindungen gezählt". */
  empty?: string;
  /** The words under the drawing: its start, what it shows, its end, such as "27.10.", "Neue Verbindungen je Tag", "heute". */
  start?: string;
  caption?: string;
  end?: string;
};

/**
 * The real history beside the figure, drawn from the values the caller has (never an invented series):
 * - `bars`: one bar per period, such as new connections per day; the last one (today) in full colour;
 * - `area`: a line with its area, such as values per minute; `failedFrom` tints the time from that index on as failed;
 *   `ticks` under it stand one per value, such as the fetch of each minute, each value above its tick;
 * - `ticks`: one tick per fetch or check, such as the fetches of today; a failed one stands red and full height.
 * At most 120 values are drawn, the newest. Where no real history exists yet (a new app, nothing counted so far), pass
 * the kind with no values and `empty`: the place of the drawing keeps its height and says so, so a history that comes
 * later moves nothing. Never draw an invented series. An area needs two values; with fewer it stands as empty.
 */
export type HeroTrend = TrendWords &
  (
    | { kind: "bars"; values: readonly number[] }
    | {
        kind: "area";
        values: readonly number[];
        failedFrom?: number;
        /** Under the area: one tick per value, such as the fetch of each minute, with its own sentence. */
        ticks?: Pick<TicksProps, "slots" | "label">;
      }
    | { kind: "ticks"; values: readonly TickState[] }
  );

/** One exception under the figure: "● 1 Fehler  Drucker Halle 2 seit 10:40", who quiet after the words. */
export type HeroException = {
  /** The state of what it counts: a dot in its colour; `off` for what rests. Without it, `icon` stands. */
  status?: Status | "off";
  /** A Tabler icon instead of a dot, for what is no state, such as `world-plus` for "selbst registriert". */
  icon?: string;
  /** The number, such as 2. */
  count: number | string;
  /** What it counts, such as "selbst registriert". */
  word: string;
  /** Who or what, quietly after it, such as "Claude Code neu seit Mo.". */
  who?: string;
};

/**
 * A history on its own, such as the values per minute of the last hour in a detail's section: the drawing of a
 * `Hero`'s trend from text edge to text edge, with its words under it (the same kinds and values as `HeroTrend`).
 */
export type TrendProps = HeroTrend;

export type HeroProps = {
  /** The one figure that counts today, such as "178" or "41.380"; in the figure type, once per screen. */
  figure: string;
  /** What the figure counts, such as "aktive Verbindungen". */
  label: string;
  /** A quiet line under it, such as "97 Personen · 23 neu in 7 Tagen". */
  meta?: string;
  /** Its real history beside it. */
  trend?: HeroTrend;
  /** What falls out of line, as one line of "● number word who" under the figure; never rows or cards. */
  exceptions?: readonly HeroException[];
};

const BAR_HEIGHT = 56;
/** A bar and the gap after it, 4.8 to 1 as the study draws them (30 bars in 520 with a gap of 3). */
const BAR = 14.4;
const BAR_GAP = 3;

/** The newest values a drawing holds: the end of the series. */
const newest = <T,>(values: readonly T[]) => (values.length > TREND_VALUES ? values.slice(-TREND_VALUES) : values);

/** Bars of a history in one box: the last in the app's colour, the others soft, a zero a quiet stub. */
const Bars = (props: { values: readonly number[]; label: string }) => {
  const shown = createMemo(() => newest(props.values));
  const width = () => Math.max(shown().length * (BAR + BAR_GAP) - BAR_GAP, 1);
  // the highest value once per drawing, not once per bar
  const top = createMemo(() => Math.max(...shown(), 1));
  return (
    <svg
      class="k2-hero-draw"
      role="img"
      aria-label={props.label}
      height={BAR_HEIGHT}
      viewBox={`0 0 ${width()} ${BAR_HEIGHT}`}
      preserveAspectRatio="none"
    >
      <For each={shown()}>
        {(value, index) => {
          const height = () => Math.max(value > 0 ? 2 : 1, (value / top()) * BAR_HEIGHT);
          return (
            <rect
              x={index() * (BAR + BAR_GAP)}
              y={BAR_HEIGHT - height()}
              width={BAR}
              height={height()}
              rx={1.5}
              data-tone={value === 0 ? "none" : index() === shown().length - 1 ? "now" : undefined}
            />
          );
        }}
      </For>
    </svg>
  );
};

const AREA_WIDTH = 400;

/**
 * A line with its area; from `failedFrom` on the time is tinted as failed. `slotted`: ticks stand under it, one per
 * value, so each value stands over the middle of its slot and the cut at the left edge of the first failed slot.
 */
const Area = (props: { values: readonly number[]; label: string; failedFrom?: number; slotted?: boolean }) => {
  const height = BAR_HEIGHT;
  const count = () => props.values.length;
  // the highest value once per drawing, not once per point
  const top = createMemo(() => Math.max(...props.values, 1));
  const x = (index: number) =>
    props.slotted ? ((index + 0.5) / count()) * AREA_WIDTH : count() > 1 ? (index / (count() - 1)) * AREA_WIDTH : 0;
  const y = (value: number) => height - 2 - (value / top()) * (height - 6);
  // from index 0 on is a failure too; an index past the last value is none
  const failed = () => {
    if (props.failedFrom == null || props.failedFrom >= count()) return undefined;
    const from = Math.max(0, props.failedFrom);
    // an object, so a cut at x 0 (all of it failed) still shows
    return { x: props.slotted ? (from / count()) * AREA_WIDTH : x(from) };
  };
  const line = createMemo(() =>
    props.values.map((value, index) => `${index ? "L" : "M"}${x(index).toFixed(1)},${y(value).toFixed(1)}`).join(""),
  );
  const ends = () => (props.slotted ? [x(0), x(count() - 1)] : [0, AREA_WIDTH]);
  return (
    <svg
      class="k2-hero-draw"
      role="img"
      aria-label={props.label}
      height={height}
      viewBox={`0 0 ${AREA_WIDTH} ${height}`}
      preserveAspectRatio="none"
    >
      <Show when={failed()}>
        {(cut) => (
          <>
            <rect class="k2-hero-failed" x={cut().x} y={0} width={AREA_WIDTH - cut().x} height={height} />
            {/* where it began to fail: a dashed red line across the drawing (the study's cut) */}
            <line class="k2-hero-cut" x1={cut().x} x2={cut().x} y1={0} y2={height} vector-effect="non-scaling-stroke" />
          </>
        )}
      </Show>
      <path class="k2-hero-fill" d={`${line()}L${ends()[1]},${height}L${ends()[0]},${height}Z`} />
      <path class="k2-hero-line" d={line()} vector-effect="non-scaling-stroke" />
    </svg>
  );
};

/** A history with its words under it: in a `Hero` beside the figure, or alone in a section of a detail. */
export const Trend = (props: TrendProps) => {
  // an area with ticks under it keeps the newest values of both, the same count, so each value stands over its tick
  const under = () => (props.kind === "area" ? props.ticks : undefined);
  const dropped = () => Math.max(0, props.values.length - TREND_VALUES);
  return (
    <div class="k2-hero-trend" data-k2-part="Trend" data-under={under() ? "" : undefined}>
      {(() => {
        // no history yet: its place keeps the drawing's height and says so
        if (props.values.length < (props.kind === "area" ? 2 : 1))
          return (
            <span class="k2-hero-none" data-kind={props.kind} role="img" aria-label={props.empty ?? props.label}>
              {props.empty}
            </span>
          );
        if (props.kind === "bars") return <Bars values={props.values} label={props.label} />;
        if (props.kind === "area")
          return (
            <Area
              values={newest(props.values)}
              label={props.label}
              failedFrom={props.failedFrom == null ? undefined : props.failedFrom - dropped()}
              slotted={props.ticks !== undefined}
            />
          );
        return <Ticks slots={newest(props.values)} label={props.label} stretch />;
      })()}
      <Show when={under()}>{(ticks) => <Ticks slots={newest(ticks().slots)} label={ticks().label} stretch />}</Show>
      <Show when={props.start || props.caption || props.end}>
        <span class="k2-hero-cap">
          <span>{props.start}</span>
          <span class="k2-hero-what">{props.caption}</span>
          <span>{props.end}</span>
        </span>
      </Show>
    </div>
  );
};

/**
 * The one figure of a screen, right under its head: the number or statement that counts today in the colour of the
 * app the thing belongs to, its real history beside it, and what falls out of line below as one line (identity B).
 * One per screen; on the phone the figure, its drawing and the exceptions stand one under the other.
 */
export const Hero = (props: HeroProps) => (
  <div class="k2-hero" data-k2-part="Hero">
    <div class="k2-hero-figure">
      <span class="k2-hero-n" data-k2-type="figure">
        {props.figure}
      </span>
      <span class="k2-hero-label">{props.label}</span>
      <Show when={props.meta}>
        <span class="k2-hero-meta">{props.meta}</span>
      </Show>
    </div>
    <Show when={props.trend}>{(trend) => <Trend {...trend()} />}</Show>
    <Show when={props.exceptions?.length}>
      {/* its quiet line on the text edges is part of the hero's drawing, no divider: the layout rules leave it be */}
      <ul class="k2-hero-ex" data-k2-figure="">
        <For each={props.exceptions}>
          {(exception) => (
            <li>
              <Show when={exception.status} fallback={<Show when={exception.icon}>{(name) => <Icon name={name()} />}</Show>}>
                {(status) => {
                  const state = status();
                  return <Dot status={state === "off" ? undefined : state} />;
                }}
              </Show>
              <b>{exception.count}</b> {exception.word}
              <Show when={exception.who}>
                <span class="k2-hero-meta">{exception.who}</span>
              </Show>
            </li>
          )}
        </For>
      </ul>
    </Show>
  </div>
);

// ── ObjectHead ───────────────────────────────────────────────────────────────────────────────────────────────────

export type ObjectHeadProps = {
  /** The thing's sign, 40 px. */
  mark: MarkProps;
  /** Its name, the page's heading, in 18. */
  name: string;
  /** One quiet line under the name, such as "Belegablage der Buchhaltung · vertraulich". */
  meta?: string;
  /** Its deeds at the end of the name's line, such as `Button` "Bearbeiten" and a menu "…"; they leave on the phone. */
  actions?: JSX.Element;
  /** Up to three key facts as pairs of label and value, such as "Verbunden" "6 von 6". */
  facts?: readonly { label: string; value: JSX.Element }[];
  /** A problem stands red right here, not in a box further down: what is wrong, and a quiet sentence why. */
  problem?: { title: string; text?: string };
};

/**
 * The head of an open thing (identity B): the tint of the app the thing belongs to as its ground, its 40 px sign, its
 * name in 18 and one meta line, then three key facts; a problem in red in place. Give it as the `head` of the detail's
 * `Pane`; the deeds stand at the end of the name's line.
 */
export const ObjectHead = (props: ObjectHeadProps) => {
  // the pane learns that it holds the head of an open thing and how many deeds it has: on the phone its bar takes them
  const actions = resolveChildren(() => props.actions);
  const deeds = actions.toArray().filter((deed) => deed !== null && deed !== undefined && deed !== false && deed !== "").length;
  useContext(PaneHeadContext)?.(deeds);
  return (
    <header class="k2-ohead" data-k2-part="ObjectHead">
      <div class="k2-ohead-top">
        <Mark {...props.mark} />
        <div class="k2-ohead-who">
          <h1 class="k2-ohead-name">{props.name}</h1>
          <Show when={props.meta}>
            <span class="k2-ohead-meta">{props.meta}</span>
          </Show>
        </div>
        <Show when={deeds > 0}>
          <div class="k2-ohead-end">{actions()}</div>
        </Show>
      </div>
      <Show when={props.facts?.length}>
        <dl class="k2-ohead-facts">
          <For each={props.facts?.slice(0, 3)}>
            {(fact) => (
              <div>
                <dt>{fact.label}</dt>
                <dd>{fact.value}</dd>
              </div>
            )}
          </For>
        </dl>
      </Show>
      <Show when={props.problem}>
        {(problem) => (
          <p class="k2-ohead-problem">
            <Icon name="alert-circle" />
            <span>
              {problem().title}
              <Show when={problem().text}>
                <span class="k2-ohead-why">{problem().text}</span>
              </Show>
            </span>
          </p>
        )}
      </Show>
    </header>
  );
};
