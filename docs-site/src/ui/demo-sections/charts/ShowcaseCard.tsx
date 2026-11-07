import { Chart, ChartSnapshotView } from "@k2b/ui";
import { createMemo, type JSX, Match, Switch } from "solid-js";
import type { ChartShowcaseExample } from "./examples/types";
import { resolveDrawing } from "./resolve";
import { ShowcaseBlockPreview } from "./ShowcaseFrame";

/** A small live chart for the overview: tooltips and keyboard inspection, no frame states. */
export function ShowcaseCardChart(props: { example: ChartShowcaseExample; height: number }): JSX.Element {
  const drawing = createMemo(() => resolveDrawing(props.example.spec));
  return (
    <div class="ui-charts-card__chart" style={{ height: `${props.height}px` }}>
      <Switch>
        <Match when={drawing().mode === "snapshot" && (drawing() as Extract<ReturnType<typeof resolveDrawing>, { mode: "snapshot" }>)}>
          {(snapshot) => (
            <ChartSnapshotView snapshot={snapshot().snapshot} selectedKey={null} onSelect={() => {}} style={{ height: "100%" }} />
          )}
        </Match>
        <Match when={drawing().mode === "live" && (drawing() as Extract<ReturnType<typeof resolveDrawing>, { mode: "live" }>)}>
          {(live) => <Chart {...live().props} style={{ height: "100%" }} />}
        </Match>
        <Match when={drawing().mode === "block" && (drawing() as Extract<ReturnType<typeof resolveDrawing>, { mode: "block" }>)}>
          {(block) => (
            <div class="ui-charts-card__block">
              <ShowcaseBlockPreview block={block().block} spec={block().spec} />
            </div>
          )}
        </Match>
      </Switch>
    </div>
  );
}
