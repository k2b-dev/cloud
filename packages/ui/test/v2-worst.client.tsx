import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { Bar, Chip, Cut, List, Notice, Pane, Row, Tabs, Workspace } from "../src/v2";

// Worst-case states of v2 primitives that change after the page is live (break-ui 25.11., review of #4210): a note that
// grows, a tab that becomes the open one, words cut in the middle in a narrow box, an amount among a row's marks.

declare global {
  interface Window {
    __k2Mounted?: boolean;
    /** Adds two lines to the note. */
    __k2GrowNote?: () => void;
    /** Opens the tab of this name. */
    __k2OpenTab?: (label: string) => void;
  }
}

const [note, setNote] = createSignal(["Erste Zeile", "Zweite Zeile", "Dritte Zeile", "Vierte Zeile"].join("\n"));
window.__k2GrowNote = () => setNote((text) => `${text}\nFünfte Zeile\nSechste Zeile`);
const views = ["Alle", "Handlungsbedarf", "Mir zugewiesen", "Wartet auf Antwort", "Erledigt", "Archiv", "Entwürfe"];
const [current, setCurrent] = createSignal("Alle");
window.__k2OpenTab = setCurrent;

const root = document.getElementById("root");
if (!root) throw new Error("worst: #root is missing");
render(
  () => (
    <Workspace
      head={
        <Bar
          start={
            <Tabs
              label="Ansichten"
              items={views.map((label) => ({ label, current: current() === label, onClick: () => setCurrent(label) }))}
            />
          }
        />
      }
    >
      <Pane label="Spalte">
        <Notice tone="ai" title="Kurz gesagt">
          {note()}
        </Notice>
        <List label="Zeilen">
          <Row lines={["Absender", "Betreff", "Vorschau"]} time="09:12" marks={<Chip status="ok">12.345,67 €</Chip>} />
          <Row
            lines={[<Cut text="ab@nordwind-industrie-holding-gruppe.example.com" keep="domain" />, "Betreff", "Vorschau"]}
            time="09:13"
          />
        </List>
      </Pane>
    </Workspace>
  ),
  root,
);
window.__k2Mounted = true;
