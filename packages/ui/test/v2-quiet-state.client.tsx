import { For } from "solid-js";
import { render } from "solid-js/web";
import { Bar, Chip, List, Pane, Row, Text, Workspace } from "../src/v2";

// A dense list of databases, as a console draws it: each line names its state as a quiet dot and word ("● Aktiv"),
// beside one full chip for comparison, so both stand on the same line height.

declare global {
  interface Window {
    __k2Mounted?: boolean;
  }
}

const bases = [
  { name: "lager-eu-central", region: "Frankfurt", status: "ok", word: "Aktiv" },
  { name: "abrechnung-2026", region: "Frankfurt", status: "warn", word: "Verzug" },
  { name: "archiv-belege", region: "Nürnberg", status: "bad", word: "Gestoppt" },
] as const;

const root = document.getElementById("root");
if (!root) throw new Error("quiet-state: #root is missing");
render(
  () => (
    <Workspace head={<Bar start={<Text type="lead">Datenbanken</Text>} />}>
      <Pane label="Datenbanken">
        <List label="Datenbanken">
          <For each={bases}>
            {(base) => (
              <Row
                icon="database"
                lines={[base.name, base.region]}
                end={
                  <Chip status={base.status} quiet>
                    {base.word}
                  </Chip>
                }
              />
            )}
          </For>
          <Row icon="database" lines={["kunden-stammdaten", "Frankfurt"]} end={<Chip status="ok">Aktiv</Chip>} />
        </List>
      </Pane>
    </Workspace>
  ),
  root,
);
window.__k2Mounted = true;
