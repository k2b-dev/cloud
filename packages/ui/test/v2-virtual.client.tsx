import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { List, type ListController, Pane, Row, Table, Workspace } from "../src/v2";

// A list of 1,000 entries whose titles wrap at narrow widths, and a table of 200 rows whose cells read a live value:
// the virtual window of v2 (review of #4211) under scrolling, resizing, Tab and a reveal by key.

declare global {
  interface Window {
    __k2Mounted?: boolean;
    /** Changes the live value every cell of the table reads. */
    __k2Tick?: () => void;
    /** Brings the entry with this key into view and gives back its row. */
    __k2Reveal?: (key: string) => HTMLElement | null;
  }
}

const entries = Array.from({ length: 1000 }, (_, index) => ({
  key: `e${index + 1}`,
  title:
    `Eintrag ${index + 1} ${index % 3 === 0 ? "mit einem langen Titel, der in einer schmalen Spalte auf eine zweite Zeile umbricht" : ""}`.trim(),
}));
const rows = Array.from({ length: 200 }, (_, index) => ({ id: `r${index + 1}` }));
const [tick, setTick] = createSignal(0);
window.__k2Tick = () => setTick((value) => value + 1);
let list: ListController | undefined;
window.__k2Reveal = (key) => list?.reveal(key) ?? null;

const root = document.getElementById("root");
if (!root) throw new Error("virtual: #root is missing");
// `<body data-case="groups">`: the same entries, seven a day under a head of their day, in a list and in a table
const day = (index: number) => Math.floor(index / 7) + 1;
if (document.body.dataset.case === "groups")
  render(
    () => (
      <Workspace>
        <Pane.Split>
          <Pane label="Liste">
            <List
              label="Einträge"
              items={entries}
              rowKey={(entry) => entry.key}
              group={(entry) => {
                const at = day(Number(entry.key.slice(1)) - 1);
                return { key: `d${at}`, label: `Tag ${at}`, count: "7" };
              }}
              controller={(handle) => {
                list = handle;
              }}
              row={(entry) => <Row lines={[entry.key, "Zweite Zeile"]} href={`#${entry.key}`} />}
            />
          </Pane>
          <Pane label="Tabelle" width={{ min: 240, default: 320 }}>
            <Table
              label="Zeilen"
              rows={entries}
              rowKey={(entry) => entry.key}
              group={(entry) => {
                const at = day(Number(entry.key.slice(1)) - 1);
                return { key: `d${at}`, head: () => `Tag ${at}`, meta: "7" };
              }}
              columns={[{ title: "Eintrag", cell: (entry) => entry.key, width: { min: 80, default: 160 } }]}
            />
          </Pane>
        </Pane.Split>
      </Workspace>
    ),
    root,
  );
else
  render(
    () => (
      <Workspace>
        <Pane.Split>
          <Pane label="Liste">
            <List
              label="Einträge"
              items={entries}
              rowKey={(entry) => entry.key}
              controller={(handle) => {
                list = handle;
              }}
              row={(entry) => <Row lines={[entry.title, "Zweite Zeile"]} href={`#${entry.key}`} />}
            />
          </Pane>
          <Pane label="Tabelle" width={{ min: 240, default: 320 }}>
            <Table
              label="Zeilen"
              rows={rows}
              rowKey={(row) => row.id}
              sticky
              columns={[
                { title: "Zeile", cell: (row) => row.id, width: { min: 80, default: 120 } },
                { title: "Wert", cell: (row) => <span data-cell={row.id}>{`${row.id}:${tick()}`}</span>, width: { min: 80, default: 120 } },
              ]}
            />
          </Pane>
        </Pane.Split>
      </Workspace>
    ),
    root,
  );
window.__k2Mounted = true;
