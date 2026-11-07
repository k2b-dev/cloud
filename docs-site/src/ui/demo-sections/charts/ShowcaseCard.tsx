import { Chart, type ChartSnapshot, ChartSnapshotView } from "@k2b/ui";
import { createMemo, type JSX, Match, onMount, Switch } from "solid-js";
import type { ChartShowcaseExample } from "./examples/types";
import { resolveDrawing } from "./resolve";
import { ShowcaseBlockPreview } from "./ShowcaseFrame";

/** The logical width every prepared chart draws in. */
const DRAWING_WIDTH = 480;
/** Height of a chart that stretches to any box, such as a line or columns. */
const STRETCH_HEIGHT = 180;

/**
 * How a card holds a drawing without clipping it: a stretching chart takes a calm fixed height; rows (bar lists,
 * horizontal bars, funnels) keep the height their rows need; a drawing that scales as a whole (pie, donut, gauge)
 * keeps its proportions; a drawing wider than the card (calendar, sankey) keeps its size and scrolls sideways,
 * newest end first.
 */
export const cardFit = (snapshot: ChartSnapshot): { mode: "stretch" | "rows" | "whole" | "wide"; style: JSX.CSSProperties } => {
  if (snapshot.width > DRAWING_WIDTH) return { mode: "wide", style: { height: `${snapshot.height}px` } };
  if (!snapshot.stretch) return { mode: "whole", style: { "aspect-ratio": `${snapshot.width} / ${snapshot.height}` } };
  if (/data-bar-layout="rows"/.test(snapshot.svg) || snapshot.height !== 280)
    return { mode: "rows", style: { height: `${snapshot.height}px` } };
  return { mode: "stretch", style: { height: `${STRETCH_HEIGHT}px` } };
};

/** A small live chart for the overview: tooltips and keyboard inspection, no frame states. */
export function ShowcaseCardChart(props: { example: ChartShowcaseExample; height: number }): JSX.Element {
  const drawing = createMemo(() => resolveDrawing(props.example.spec));
  return (
    <Switch>
      <Match when={drawing().mode === "snapshot" && (drawing() as Extract<ReturnType<typeof resolveDrawing>, { mode: "snapshot" }>)}>
        {(snapshot) => {
          const fit = () => cardFit(snapshot().snapshot);
          let scroller: HTMLDivElement | undefined;
          // A wide drawing opens at its newest end, like the calendar in a frame.
          onMount(() => {
            if (scroller && fit().mode === "wide") scroller.scrollLeft = scroller.scrollWidth;
          });
          return (
            <div ref={scroller} class="ui-charts-card__chart" data-fit={fit().mode} style={fit().style}>
              <div class="ui-charts-card__drawing" style={fit().mode === "wide" ? { width: `${snapshot().snapshot.width}px` } : undefined}>
                <ChartSnapshotView snapshot={snapshot().snapshot} selectedKey={null} onSelect={() => {}} style={{ height: "100%" }} />
              </div>
            </div>
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
