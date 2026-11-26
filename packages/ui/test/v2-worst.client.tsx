import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { Bar, Button, Chip, Cut, Input, List, Menu, Notice, Pane, Row, Table, Tabs, Workspace } from "../src/v2";

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
// `<body data-case="table">`: a folder as a large table (Files), in groups, whose phone rows carry a date
const files = [
  { id: "f1", name: "Angebote", kind: "Ordner", detail: "Ordner · Link", changed: "25.11.2026, 14:32" },
  { id: "f2", name: "Zuschnitt Küchenfront.dxf", kind: "Dateien", detail: "1.000 KB · Team", changed: "1.11.2026, 09:05" },
  {
    id: "f3",
    name: "Stripe Zahlungen",
    kind: "Dateien",
    detail: `{"id":"evt_3QxK8m","type":"payment_intent.succeeded","data":${"x".repeat(240)}}`,
    changed: "heute, 11:26",
  },
];
const [picked, setPicked] = createSignal<readonly string[]>([]);
const [marked, setMarked] = createSignal(true);
// `<body data-case="head">`: a head on the phone that holds views, a search, a filter and two deeds that keep their words
const scenario = document.body.dataset.case;
// `<body data-case="rows">`: endpoints whose second line is an address of 300 characters without a break, beside a deed
const address = `https://cloud.example.test/tools/api/webhooks/receive/${"segmentwithoutanybreak".repeat(12)}`;
const hyphened = `https://cloud.example.test/tools/api/webhooks/receive/${"segment-with-breaks-".repeat(12)}end`;
if (scenario === "rows")
  render(
    () => (
      <Workspace>
        <Pane label="Spalte">
          <List label="Endpunkte">
            <Row
              icon="webhook"
              lines={["Zahlungseingänge der Buchhaltung", address]}
              meta="123.456 Anfragen"
              time="zuletzt heute, 11:29"
              action={{ label: "Adresse kopieren", icon: "copy", onClick: () => undefined }}
            />
            <Row icon="webhook" lines={["Stripe Zahlungen", hyphened]} time="heute, 11:26" marks={<Chip status="ok">POST</Chip>} />
            <Row
              icon="webhook"
              lines={[
                "Protokoll",
                <a class="k2-link" href="#protokoll">
                  Letzte Anfragen öffnen
                </a>,
              ]}
              time="heute, 11:20"
            />
          </List>
        </Pane>
      </Workspace>
    ),
    root,
  );
else if (scenario === "table" || scenario === "head" || scenario === "headmenu" || scenario === "headicon" || scenario === "headtwo")
  render(
    () => (
      <Workspace
        head={
          <Bar
            start={
              <Tabs
                label="Ansichten"
                items={[
                  { label: "Alle", current: true, onClick: () => undefined },
                  { label: "Ungelesen", onClick: () => undefined },
                ]}
              />
            }
            end={
              scenario === "head" ? (
                <>
                  <Input type="search" icon="search" label="Suchen" placeholder="Suchen" />
                  <Button variant="ghost" icon="adjustments-horizontal" label="Filter" />
                  <Button keep>Suche fokussieren</Button>
                  <Button keep disabled>
                    Gesperrt
                  </Button>
                </>
              ) : scenario === "headmenu" ? (
                <>
                  <Button keep pressed={marked()} onClick={() => setMarked(!marked())}>
                    Markiert
                  </Button>
                  <Menu label="Weitere Aktionen" items={[{ label: "Einstellungen", onClick: () => undefined }]} />
                </>
              ) : scenario === "headicon" ? (
                // a kept deed with words beside a kept icon button, and no "…" of the app's own
                <>
                  <Button keep>Freigeben</Button>
                  <Button keep icon="star" label="Favorit" />
                </>
              ) : scenario === "headtwo" ? (
                // two "…" of the app's own beside a kept deed: the first takes the deed, the second keeps its own
                <>
                  <Button keep>Freigeben</Button>
                  <Menu label="Weitere Aktionen" items={[{ label: "Einstellungen", onClick: () => undefined }]} />
                  <Menu icon="eye" label="Ansicht" items={[{ label: "Kompakt", onClick: () => undefined }]} />
                </>
              ) : undefined
            }
          />
        }
      >
        <Pane.Split>
          <Pane label="Spalte" width={{ min: 440, default: 720 }}>
            <Table
              label="Dateien"
              rows={files}
              rowKey={(file) => file.id}
              select={{ selected: picked(), onChange: setPicked, all: "Alle Dateien", row: (file) => file.name }}
              group={(file) => ({ key: file.kind, head: () => file.kind, count: "1" })}
              columns={[
                { title: "Name", cell: (file) => ({ lines: [file.name, file.detail] }), width: { min: 160, default: 320 } },
                { title: "Geändert", cell: (file) => file.changed, width: { min: 120, default: 160 } },
              ]}
              phone={(file) => ({
                lines: [file.name, file.detail],
                time: file.changed,
                marks: file.id === "f3" ? <Chip status="ok">POST</Chip> : undefined,
              })}
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
