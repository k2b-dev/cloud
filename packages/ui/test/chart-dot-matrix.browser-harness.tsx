import { createSignal, For, Show } from "solid-js";
import { render } from "solid-js/web";
import Chart from "../src/content/Chart";
import { Widget } from "../src/widgets/Widget";
import { dotMatrixFixtures } from "./chart-dot-matrix-fixtures";

const [state, setState] = createSignal("data");
render(
  () => (
    <>
      <div class="states">
        <For each={["data", "loading", "empty", "error", "stale"]}>{(s) => <button onClick={() => setState(s)}>{s}</button>}</For>
      </div>
      <main class="cards">
        <For each={dotMatrixFixtures}>
          {(spec, i) => (
            <section class="sample" data-example={i()}>
              <Widget
                title={["Campaign engagement", "Counts with a missing region", "Newsletter shares"][i()]!}
                meta={state() === "stale" ? "Updated 09:12 · Refresh failed" : "Invented quarterly data"}
                size="content"
              >
                <div class="content-box" style={{ height: "254px" }}>
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
                    <Chart
                      {...spec}
                      labels={{ interactiveChart: ["Campaign engagement", "Counts with a missing region", "Newsletter shares"][i()] }}
                      style={{ height: "100%" }}
                    />
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
