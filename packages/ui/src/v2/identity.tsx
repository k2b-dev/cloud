import { For, type JSX, children as resolveChildren, Show, useContext } from "solid-js";
import { Dot, Icon, Mark, type MarkProps, type TickState, Ticks } from "./marks";
import { PaneHeadContext } from "./pane-head";
import type { Status } from "./types";

// ── Hero ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The real history beside the figure, drawn from the values the caller has (never an invented series):
 * - `bars`: one bar per period, such as new connections per day; the last one (today) in full colour;
 * - `area`: a line with its area, such as values per minute; `from` tints the time from that index on as failed;
 * - `ticks`: one tick per fetch or check, such as the fetches of today; a failed one stands red and full height.
 * Where no real history exists yet (a new app, nothing counted so far), pass the kind with no values and `empty`: the
 * place of the drawing keeps its height and says so, so a history that comes later moves nothing. Never draw an
 * invented series. An area needs two values; with fewer it stands as empty.
 */
export type HeroTrend = {
  /** What the drawing says, in one sentence a person who cannot see it gets the same from. */
  label: string;
  /** What stands in the drawing's place while there is no history, such as "Noch keine Verbindungen gezählt". */
  empty?: string;
  /** The words under the drawing: its start, what it shows, its end, such as "27.10.", "Neue Verbindungen je Tag", "heute". */
  start?: string;
  caption?: string;
  end?: string;
} & (
  | { kind: "bars"; values: readonly number[] }
  | { kind: "area"; values: readonly number[]; failedFrom?: number }
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

/** Bars of a history in one box: the last in the app's colour, the others soft, a zero a quiet stub. */
const Bars = (props: { values: readonly number[]; label: string }) => {
  const width = () => Math.max(props.values.length * (BAR + BAR_GAP) - BAR_GAP, 1);
  const top = () => Math.max(...props.values, 1);
  return (
    <svg
      class="k2-hero-draw"
      role="img"
      aria-label={props.label}
      height={BAR_HEIGHT}
      viewBox={`0 0 ${width()} ${BAR_HEIGHT}`}
      preserveAspectRatio="none"
    >
      <For each={props.values}>
        {(value, index) => {
          const height = () => Math.max(value > 0 ? 2 : 1, (value / top()) * BAR_HEIGHT);
          return (
            <rect
              x={index() * (BAR + BAR_GAP)}
              y={BAR_HEIGHT - height()}
              width={BAR}
              height={height()}
              rx={1.5}
              data-tone={value === 0 ? "none" : index() === props.values.length - 1 ? "now" : undefined}
            />
          );
        }}
      </For>
    </svg>
  );
};

/** A line with its area; from `failedFrom` on the time is tinted as failed. */
const Area = (props: { values: readonly number[]; label: string; failedFrom?: number }) => {
  const width = 400;
  const height = BAR_HEIGHT;
  const top = () => Math.max(...props.values, 1);
  const x = (index: number) => (props.values.length > 1 ? (index / (props.values.length - 1)) * width : 0);
  const y = (value: number) => height - 2 - (value / top()) * (height - 6);
  // from index 0 on is a failure too; an index past the last value is none
  const failed = () =>
    props.failedFrom != null && props.failedFrom < props.values.length ? { value: Math.max(0, props.failedFrom) } : undefined;
  const line = () => props.values.map((value, index) => `${index ? "L" : "M"}${x(index).toFixed(1)},${y(value).toFixed(1)}`).join("");
  return (
    <svg
      class="k2-hero-draw"
      role="img"
      aria-label={props.label}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
    >
      <Show when={failed()}>
        {(from) => (
          <>
            <rect class="k2-hero-failed" x={x(from().value)} y={0} width={width - x(from().value)} height={height} />
            {/* where it began to fail: a dashed red line across the drawing (the study's cut) */}
            <line class="k2-hero-cut" x1={x(from().value)} x2={x(from().value)} y1={0} y2={height} vector-effect="non-scaling-stroke" />
          </>
        )}
      </Show>
      <path class="k2-hero-fill" d={`${line()}L${width},${height}L0,${height}Z`} />
      <path class="k2-hero-line" d={line()} vector-effect="non-scaling-stroke" />
    </svg>
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
    <Show when={props.trend}>
      {(trend) => (
        <div class="k2-hero-trend">
          {(() => {
            const shown = trend();
            // no history yet: its place keeps the drawing's height and says so
            if (shown.values.length < (shown.kind === "area" ? 2 : 1))
              return (
                <span class="k2-hero-none" data-kind={shown.kind} role="img" aria-label={shown.empty ?? shown.label}>
                  {shown.empty}
                </span>
              );
            if (shown.kind === "bars") return <Bars values={shown.values} label={shown.label} />;
            if (shown.kind === "area") return <Area values={shown.values} label={shown.label} failedFrom={shown.failedFrom} />;
            return <Ticks slots={shown.values} label={shown.label} stretch />;
          })()}
          <Show when={trend().start || trend().caption || trend().end}>
            <span class="k2-hero-cap">
              <span>{trend().start}</span>
              <span class="k2-hero-what">{trend().caption}</span>
              <span>{trend().end}</span>
            </span>
          </Show>
        </div>
      )}
    </Show>
    <Show when={props.exceptions?.length}>
      <ul class="k2-hero-ex">
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
