import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import Chart from "../src/content/Chart";
import { LocaleProvider } from "../src/intl/locale";
import { waterfallFixture } from "./waterfall-fixture";

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
              <Chart kind="waterfall" {...waterfallFixture} style={{ height: "280px" }} />
            )}
          </div>
        </section>
      </main>
    </LocaleProvider>
  ),
  document.getElementById("root")!,
);
