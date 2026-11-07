import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import Chart from "../src/content/Chart";
import { LocaleProvider } from "../src/intl/locale";
import { lineForecastFixture } from "./line-forecast-fixture";

const [state, setState] = createSignal("data");
render(
  () => (
    <LocaleProvider locale="de">
      <main>
        <nav>
          {["data", "loading", "empty", "error", "stale"].map((s) => (
            <button type="button" onClick={() => setState(s)}>
              {s}
            </button>
          ))}
        </nav>
        <section class="line-forecast-panel">
          <h2>Can the studio cover its next payments?</h2>
          <p class="meta">{state() === "stale" ? "Veraltet · Studio sales" : "Studio sales · January to June"}</p>
          <div class="line-forecast-frame">
            {state() === "loading" ? (
              <p role="status">Daten werden geladen.</p>
            ) : state() === "empty" ? (
              <p>Noch keine Umsätze.</p>
            ) : state() === "error" ? (
              <div role="alert">
                Daten konnten nicht geladen werden.
                <button type="button" onClick={() => setState("data")}>
                  Erneut versuchen
                </button>
              </div>
            ) : (
              <Chart
                kind="line"
                {...lineForecastFixture}
                yAxis={{
                  format: (value) =>
                    new Intl.NumberFormat("de", { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format(value),
                }}
                style={{ height: "280px" }}
              />
            )}
          </div>
        </section>
        <section class="line-forecast-panel">
          <h2>Steps at the next observation</h2>
          <Chart
            kind="line"
            {...lineForecastFixture}
            step="before"
            yAxis={{
              format: (value) =>
                new Intl.NumberFormat("de", { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format(value),
            }}
            style={{ height: "280px" }}
          />
        </section>
      </main>
    </LocaleProvider>
  ),
  document.getElementById("root")!,
);
