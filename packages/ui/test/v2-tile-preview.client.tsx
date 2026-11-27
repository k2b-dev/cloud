import { render } from "solid-js/web";
import { Pane, Text, Tiles, Workspace } from "../src/v2";

// The first start of Grids (W4) with the approved mockup empty-start-tiles v4: four cards with a preview across their
// top, a sign for the blank base, small tables of the templates' main tables; and a notebook's page as Notebooks shows
// it. `data-worst` on the body asks for the longest words a template could carry.

declare global {
  interface Window {
    __k2Mounted?: boolean;
  }
}

const root = document.getElementById("root");
if (!root) throw new Error("tile preview: #root is missing");
const worst = document.body.dataset.worst === "1";
render(
  () => (
    <Workspace>
      <Pane label="Grids" center>
        <Text type="lead">Leg deine erste Base an</Text>
        <Tiles
          label="Wege zum Start"
          variant="card"
          perRow={4}
          items={[
            {
              icon: "plus",
              color: "#0369a1",
              title: "Leere Base",
              meta: "Noch ohne Tabellen",
              href: "?new=blank",
              preview: { icon: "table" },
            },
            {
              icon: "wallet",
              color: "#0369a1",
              title: "Private Finanzen",
              meta: "5 Tabellen",
              href: "?new=finance",
              preview: {
                table: {
                  columns: ["Datum", "Zahlungspartner", "Konto"],
                  rows: [
                    ["01.04.", worst ? "Arbeitgeber-Gesellschaft-mit-beschränkter-Haftung-Nordhausen" : "Arbeitgeber GmbH", "Hauptkonto"],
                    ["02.04.", "Vermieter", "Hauptkonto"],
                    ["05.04.", "Markt vor Ort", "Visa"],
                  ],
                },
              },
            },
            {
              icon: "packages",
              color: "#0369a1",
              title: "Inventar",
              meta: "6 Tabellen",
              href: "?new=inventory",
              preview: {
                table: {
                  columns: ["Name", "Kategorie", "Lagerort"],
                  rows: [
                    ["Sony-A7-Gehäuse", "Kameras", "Studioregal"],
                    ["Funkmikrofon-Set", "Audio", "Studioregal"],
                    ["HDMI-Kabel, 5 m", "Kabel", "Lagerschrank"],
                  ],
                },
              },
            },
            {
              icon: "notebook",
              color: "#0369a1",
              title: "Tagebuch",
              meta: "6 Seiten",
              href: "?new=journal",
              preview: { page: { title: "Tagebuch", text: "Beginne hier. Schreibe täglich eine kurze Notiz." } },
            },
          ]}
        />
      </Pane>
    </Workspace>
  ),
  root,
);
window.__k2Mounted = true;
