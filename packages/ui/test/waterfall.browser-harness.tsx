import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import Chart from "../src/content/Chart";
import { ChartExplorer } from "../src/content/ChartExplorer";
import { prepareChartSnapshot } from "../src/content/chart-snapshot";
import { LocaleProvider } from "../src/intl/locale";
import { waterfallFixture } from "./waterfall-fixture";

const snapshot = prepareChartSnapshot(
  { kind: "waterfall", ...waterfallFixture, locale: "de" },
  {
    key: ({ datum }) => String(datum.index),
    tooltip: ({ datum }) => ({
      title: datum.label,
      rows: datum.values.map((field) => ({ label: field.key, value: field.formatted ?? String(field.value) })),
    }),
  },
);
const rows = snapshot.marks.map((mark) => ({ key: mark.rowKey, amount: String(mark.datum.values[0]?.value) }));
const [selected, setSelected] = createSignal(false);
const [state, setState] = createSignal("data");
render(
  () => (
    <LocaleProvider locale="de">
      <main>
        <nav>
          <button type="button" onClick={() => setSelected(!selected())}>
            Select outflow
          </button>
          {["data", "loading", "empty", "error", "stale"].map((s) => (
            <button type="button" onClick={() => setState(s)}>
              {s}
            </button>
          ))}
        </nav>
        <section class="waterfall-panel">
          <h2>Vom Anfang bis zum Ende des Monats</h2>
          <p class="meta">{state() === "stale" ? "Veraltet · Oktober 2026" : "Geschäftskonto · Oktober 2026"}</p>
          <div class="waterfall-frame">
            {state() === "loading" ? (
              <p role="status">Daten werden geladen.</p>
            ) : state() === "empty" ? (
              <p>Noch keine Kontobewegungen.</p>
            ) : state() === "error" ? (
              <div role="alert">
                Daten konnten nicht geladen werden.
                <button type="button" onClick={() => setState("data")}>
                  Erneut versuchen
                </button>
              </div>
            ) : (
              <Chart
                selected={selected() ? { role: "item", index: 2 } : null}
                kind="waterfall"
                locale="de"
                {...waterfallFixture}
                style={{ height: "280px" }}
              />
            )}
          </div>
        </section>
        <div class="state-explorer">
          <ChartExplorer
            title="Kontobewegungen"
            description={state() === "stale" ? "Veraltet · Oktober 2026" : "Oktober 2026"}
            data={{ chart: snapshot, rows: state() === "data" || state() === "stale" ? rows : [] }}
            columns={[{ id: "amount", label: "Betrag", value: (row) => row.amount }]}
            height="280px"
            renderDetails={false}
            empty={
              state() === "loading" ? (
                <p role="status">Daten werden geladen.</p>
              ) : state() === "error" ? (
                <div role="alert">
                  Daten konnten nicht geladen werden.
                  <button type="button" onClick={() => setState("data")}>
                    Erneut versuchen
                  </button>
                </div>
              ) : (
                <p>Noch keine Kontobewegungen.</p>
              )
            }
          />
        </div>
      </main>
    </LocaleProvider>
  ),
  document.getElementById("root")!,
);
