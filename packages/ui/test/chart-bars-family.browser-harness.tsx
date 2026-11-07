import { createSignal, For, Show } from "solid-js";
import { render } from "solid-js/web";
import Chart from "../src/content/Chart";
import type { ChartDatumRef } from "../src/content/chart-inspection-core";
import { Widget } from "../src/widgets/Widget";
import { barFamilyFixtures } from "./chart-bars-family-fixtures";

const withoutTitle = (spec: (typeof barFamilyFixtures)[number]) => {
  const { title, ...chart } = spec;
  return chart;
};
const [state, setState] = createSignal("data");
const [selected, setSelected] = createSignal<ChartDatumRef | null>({ role: "item", index: 0 });
render(
  () => (
    <>
      <div class="states">
        <For each={["data", "loading", "empty", "error", "stale"]}>{(s) => <button onClick={() => setState(s)}>{s}</button>}</For>
      </div>
      <div id="old-bar-outline" style={{ height: "240px" }}>
        <Chart
          kind="bar"
          data={[
            { label: "Old A", value: 10 },
            { label: "Old B", value: 20 },
          ]}
          selected={selected()}
          onSelect={(selection) => setSelected(selection.datum)}
        />
      </div>
      <main class="cards">
        <For each={barFamilyFixtures}>
          {(spec, i) => (
            <section class="sample" data-example={i()}>
              <Widget
                title={spec.title!}
                meta={state() === "stale" ? "Updated 09:12 · Refresh failed" : "Invented quarterly data"}
                size="content"
              >
                <div class="content-box" style={{ height: i() === 3 ? "300px" : "240px" }}>
                  <Show
                    when={state() === "data" || state() === "stale"}
                    fallback={
                      <div class="state" role="status">
                        {state() === "loading" ? (
                          "Loading …"
                        ) : state() === "empty" ? (
                          "No orders in this period."
                        ) : (
                          <>
                            The data could not be loaded. <button onClick={() => setState("data")}>Retry</button>
                          </>
                        )}
                      </div>
                    }
                  >
                    <Chart {...withoutTitle(spec)} labels={{ interactiveChart: spec.title }} style={{ height: "100%" }} />
                  </Show>
                </div>
              </Widget>
            </section>
          )}
        </For>
      </main>
    </>
  ),
  document.getElementById("root")!,
);
