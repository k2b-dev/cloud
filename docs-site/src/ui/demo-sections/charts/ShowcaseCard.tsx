import { Chart, type ChartSnapshot, ChartSnapshotView } from "@k2b/ui";
import { calendarViewportHeight } from "@k2b/ui/charts";
import { createMemo, For, type JSX, Match, onMount, Show, Switch } from "solid-js";
import type { ChartShowcaseExample, JsonValue } from "./examples/types";
import { resolveDrawing } from "./resolve";
import { ShowcaseBlockPreview } from "./ShowcaseFrame";

/** The logical width every prepared chart draws in. */
const DRAWING_WIDTH = 480;
/** Height of a chart that stretches to any box, such as a line or columns. */
const STRETCH_HEIGHT = 180;
/** Height of one bar-gauge row in drawing units; the last row's anchor sits in its middle. */
const BAR_GAUGE_ROW = 28;

/**
 * How a card holds a drawing without clipping it: a stretching chart takes a calm fixed height; rows (bar lists,
 * horizontal bars, funnels) keep the height their rows need; a drawing that scales as a whole (pie, donut, gauge)
 * keeps its proportions. Calendars own their square-cell size and scroll viewport; other wide drawings keep
 * their logical width in the card.
 */
export const cardFit = (
  snapshot: ChartSnapshot,
  /** A two-column card keeps the drawing's own height, so guides and labels keep their room. */
  span: 1 | 2 = 1,
): { mode: "stretch" | "rows" | "whole" | "wide" | "calendar"; style: JSX.CSSProperties; drawing?: JSX.CSSProperties } => {
  if (snapshot.maxWidth) return { mode: "calendar", style: { "container-type": "inline-size" } };
  if (snapshot.width > DRAWING_WIDTH) return { mode: "wide", style: { height: `${snapshot.height}px` } };
  if (!snapshot.stretch) return { mode: "whole", style: { "aspect-ratio": `${snapshot.width} / ${snapshot.height}` } };
  // A bar gauge draws its rows at the top of a fixed minimum height; the card shows the rows at the same scale and
  // leaves out the empty rest.
  if (snapshot.kind === "barGauge") {
    const bottom = Math.min(snapshot.height, Math.max(...snapshot.marks.map((mark) => mark.datum.anchor[1])) + BAR_GAUGE_ROW);
    return {
      mode: "rows",
      style: { "aspect-ratio": `${snapshot.width} / ${bottom}`, overflow: "hidden" },
      drawing: { height: "auto", "aspect-ratio": `${snapshot.width} / ${snapshot.height}` },
    };
  }
  if (/data-bar-layout="rows"/.test(snapshot.svg) || snapshot.height !== 280)
    return { mode: "rows", style: { height: `${snapshot.height}px` } };
  return { mode: "stretch", style: { height: `${span === 2 ? snapshot.height : STRETCH_HEIGHT}px` } };
};

/**
 * Kinds whose labels and marks need more than one overview column: long row names on the left (state timeline),
 * labels on both sides (sankey), or marks and guides that crowd a narrow plot (bubble). Their cards span two columns
 * where the overview has them.
 */
const twoColumnKinds = new Set(["bubble", "sankey", "stateTimeline"]);
export const cardSpan = (example: ChartShowcaseExample): 1 | 2 => {
  const spec = example.spec;
  const kind = spec !== null && typeof spec === "object" && !Array.isArray(spec) ? spec.kind : undefined;
  return typeof kind === "string" && twoColumnKinds.has(kind) ? 2 : 1;
};

/** Slice names of a pie or donut description, in drawing order. */
const sliceLabels = (spec: JsonValue): string[] =>
  spec !== null && typeof spec === "object" && !Array.isArray(spec) && Array.isArray(spec.data)
    ? spec.data.flatMap((entry) =>
        entry !== null && typeof entry === "object" && !Array.isArray(entry) && typeof entry.label === "string" ? [entry.label] : [],
      )
    : [];

/** A small live chart for the overview: tooltips and keyboard inspection, no frame states. */
export function ShowcaseCardChart(props: { example: ChartShowcaseExample; height: number }): JSX.Element {
  const drawing = createMemo(() => resolveDrawing(props.example.spec));
  return (
    <Switch>
      <Match when={drawing().mode === "snapshot" && (drawing() as Extract<ReturnType<typeof resolveDrawing>, { mode: "snapshot" }>)}>
        {(snapshot) => {
          const fit = () => cardFit(snapshot().snapshot, cardSpan(props.example));
          let scroller: HTMLDivElement | undefined;
          // A wide drawing opens at its newest end, like the calendar in a frame.
          onMount(() => {
            if (scroller && fit().mode === "wide") scroller.scrollLeft = scroller.scrollWidth;
          });
          // Slices name themselves in a legend under the card's drawing; the drawing's own legend is too small there.
          const slices = () =>
            snapshot().snapshot.kind === "pie" || snapshot().snapshot.kind === "donut" ? sliceLabels(props.example.spec) : [];
          return (
            <>
              <div ref={scroller} class="ui-charts-card__chart" data-fit={fit().mode} style={fit().style}>
                <div
                  class="ui-charts-card__drawing"
                  style={
                    fit().mode === "calendar"
                      ? {
                          height: calendarViewportHeight({
                            ...snapshot().snapshot,
                            minWidth: snapshot().snapshot.minWidth!,
                            maxWidth: snapshot().snapshot.maxWidth!,
                          }),
                        }
                      : fit().mode === "wide"
                        ? { width: `${snapshot().snapshot.width}px` }
                        : fit().drawing
                  }
                >
                  <ChartSnapshotView snapshot={snapshot().snapshot} selectedKey={null} onSelect={() => {}} style={{ height: "100%" }} />
                </div>
              </div>
              <Show when={slices().length}>
                {/* stdlib-chart: the drawing's own palette, so every swatch matches its slice. */}
                <ul class="k2b-chart-legend ui-charts-card__legend stdlib-chart" aria-label="Legend">
                  <For each={slices()}>
                    {(label, index) => (
                      <li>
                        <span
                          class="k2b-chart-legend__swatch"
                          style={{ "--k2b-chart-legend-color": `var(--stdlib-chart-c${(index() % 8) + 1})` }}
                          aria-hidden="true"
                        />
                        {label}
                      </li>
                    )}
                  </For>
                </ul>
              </Show>
            </>
          );
        }}
      </Match>
      <Match when={drawing().mode === "live" && (drawing() as Extract<ReturnType<typeof resolveDrawing>, { mode: "live" }>)}>
        {(live) => (
          <div class="ui-charts-card__chart" style={{ height: `${props.height}px` }}>
            <Chart {...live().props} style={{ height: "100%" }} />
          </div>
        )}
      </Match>
      <Match when={drawing().mode === "block" && (drawing() as Extract<ReturnType<typeof resolveDrawing>, { mode: "block" }>)}>
        {(block) => (
          <div class="ui-charts-card__chart ui-charts-card__block">
            <ShowcaseBlockPreview block={block().block} spec={block().spec} />
          </div>
        )}
      </Match>
    </Switch>
  );
}
