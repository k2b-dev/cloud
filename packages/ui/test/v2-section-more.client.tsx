import { render } from "solid-js/web";
import { Pane, Row, Section, Workspace } from "../src/v2";

// The last events of an endpoint as the list-detail recipe draws them: a section with a symbol, rows with symbols, and
// its way to all of it at the end ("Alle Ereignisse ›"); and a plain section with plain rows. The way stands under the
// rows on their text edge (Valentin 26.11.: "das sollte links in der Zelle sein, nicht rechts"). In a side column the
// way stays a row of its own.

declare global {
  interface Window {
    __k2Mounted?: boolean;
  }
}

const root = document.getElementById("root");
if (!root) throw new Error("section more: #root is missing");
render(
  () => (
    <Workspace>
      <Pane.Split>
        <Pane label="Endpunkt">
          <Section
            icon="list"
            title="Letzte Ereignisse"
            count={2}
            more={{ label: "Alle Ereignisse", forward: true, onClick: () => undefined }}
          >
            <Row icon="alert-circle" lines={["Zeitüberschreitung", "nach 30 s"]} time="gestern" />
            <Row icon="check" lines={["38 Ereignisse angenommen"]} time="Mo." />
          </Section>
          {/* a section a link leads to (`#notes`), whose way folds the list back: its symbol points up */}
          <Section id="notes" title="Notizen" more={{ label: "Weniger Notizen", icon: "chevron-up", onClick: () => undefined }}>
            <Row lines={["Abholung nur samstags"]} />
          </Section>
        </Pane>
        {/* in a side column the way is a row of its own, from edge to edge (as before) */}
        <Pane label="Angaben" side>
          <Section icon="address-book" title="Kontakt" more={{ label: "Alle Angaben", meta: "Bank, Person", onClick: () => undefined }}>
            <Row lines={["o.brandner@example.de"]} />
          </Section>
        </Pane>
      </Pane.Split>
    </Workspace>
  ),
  root,
);
window.__k2Mounted = true;
