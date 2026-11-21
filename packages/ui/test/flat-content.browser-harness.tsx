import { render } from "solid-js/web";
import { ProgressPath } from "../src/content/ProgressPath";
import { TaskRow } from "../src/content/TaskRow";
import { LocaleProvider } from "../src/intl/locale";

const path = [
  { label: "Bestellt", detail: "3. Nov.", done: true },
  { label: "Bezahlt", detail: "3. Nov.", done: true },
  { label: "Versendet", detail: "heute", current: true },
  { label: "Zugestellt", detail: "erwartet 8. Nov.", icon: "ti ti-home" },
];

render(
  () => (
    <LocaleProvider locale="de">
      <main id="app">
        <section class="column k2b-divided" data-probe="tasks">
          <TaskRow
            icon="ti ti-package-export"
            count={3}
            text="Nicht verkaufte Artikel sind abholbereit"
            detail="bis 12. Dez. 2026"
            action="Herausgabe vorbereiten"
            href="#herausgabe"
          />
          <TaskRow icon="ti ti-file-invoice" text="Abrechnung Oktober senden" action="Abrechnung öffnen" onClick={() => undefined} />
          <TaskRow
            icon="ti ti-truck-return"
            count={12}
            text="Retouren aus der Novembersammlung, der Oktobersammlung und der Sammlung vom Sommerfest warten im Lager in Halle zwei, Regal C bis F, seit mehreren Wochen auf die Entscheidung über Weiterverkauf, Spende an das Sozialkaufhaus oder Entsorgung"
            action="Entscheiden"
            href="#retouren"
          />
          <TaskRow icon="ti ti-signature" text="Vertrag gegenzeichnen" detail="nach der Unterschrift" action="Unterschreiben" disabled />
          <TaskRow icon="ti ti-link" text="Link ohne Ziel" action="Öffnen" href="#nie" disabled />
        </section>
        <section class="column" data-probe="path">
          <ProgressPath label="Weg der Bestellung 2026-0418" steps={path} />
        </section>
        <section class="column narrow" data-probe="path-narrow">
          <ProgressPath label="Weg der Bestellung 2026-0419" steps={path} />
        </section>
      </main>
    </LocaleProvider>
  ),
  document.getElementById("root")!,
);
