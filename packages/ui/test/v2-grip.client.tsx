import { For } from "solid-js";
import { render } from "solid-js/web";
import { Band, Facts, Pane, Section, Text, Workspace } from "../src/v2";

// A record's page in short: a band above, then a main column beside an info column whose content is taller than the
// window, all in one pane that scrolls. The line between the two columns runs below the window, as in the Kundenakte.

declare global {
  interface Window {
    __k2Mounted?: boolean;
  }
}

const facts = Array.from({ length: 24 }, (_, index) => ({ label: `Angabe ${index + 1}`, value: `Wert ${index + 1}` }));

const root = document.getElementById("root");
if (!root) throw new Error("grip: #root is missing");
render(
  () => (
    <Workspace>
      <Pane label="Akte">
        <Band>
          <Text type="lead">Ottilie Brandner</Text>
          <For each={[1, 2, 3, 4, 5, 6]}>{(line) => <Text>Zeile {line} über den Spalten</Text>}</For>
        </Band>
        <Pane.Split>
          <Pane label="Überblick">
            <Section title="Vorgänge">
              <Text>Nichts offen.</Text>
            </Section>
          </Pane>
          <Pane side label="Breite der Angaben" width={{ min: 280, default: 360 }}>
            <Section title="Angaben">
              <Facts items={facts} />
            </Section>
          </Pane>
        </Pane.Split>
      </Pane>
    </Workspace>
  ),
  root,
);
window.__k2Mounted = true;
