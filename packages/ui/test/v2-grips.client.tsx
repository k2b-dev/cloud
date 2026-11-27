import { render } from "solid-js/web";
import { Pane, Table, Text, Workspace } from "../src/v2";

// A mail workspace in short: a sidebar (200..248), a list (280..360) beside a reader that keeps 400, and an info
// column on the right (240..300); the reader holds a table whose first two columns have widths (120..200, 80..140).
// In a 1400 px window: sidebar 248 | list 360 | reader 488 | info 300.

declare global {
  interface Window {
    __k2Mounted?: boolean;
    /** "widths": a wide table whose columns all have a width, instead of the mail workspace */
    __k2GripsFixture?: "widths";
  }
}

// "widths": one wide pane (1400 − the sidebar) with a table whose columns all have widths (708 px at their defaults), so
// they grow above their defaults and "Gruppe" stands wider than its 268 px; "Einlieferer" drops when the room is short.
type Group = { name: string; role: string; from: string; state: string };
const groups: Group[] = [
  { name: "Werkstatt Nord", role: "Leitung", from: "Holzhandel Brandner", state: "Aktiv" },
  { name: "Büro", role: "Mitglied", from: "Spedition Kolb", state: "Ruht" },
];

type Mail = { subject: string; from: string; date: string };
const mails: Mail[] = [
  { subject: "Angebot Eichenplatten", from: "Holzhandel Brandner", date: "24.11." },
  { subject: "Lieferung Freitag", from: "Spedition Kolb", date: "23.11." },
];

const root = document.getElementById("root");
if (!root) throw new Error("grips: #root is missing");
const widths = () => (
  <Workspace sidebar={<Text>Ordner</Text>} sidebarWidth={{ min: 200, default: 248 }} sidebarLabel="Breite der Ordner">
    <Pane label="Gruppen">
      <Table
        label="Gruppen"
        rows={groups}
        columns={[
          { title: "Gruppe", width: { min: 160, default: 268 }, cell: (group) => group.name },
          { title: "Rolle", width: { min: 100, default: 140 }, cell: (group) => group.role },
          { title: "Einlieferer", width: { min: 120, default: 180 }, drop: true, cell: (group) => group.from },
          { title: "Stand", width: { min: 100, default: 120 }, cell: (group) => group.state },
        ]}
      />
    </Pane>
  </Workspace>
);

render(
  () =>
    window.__k2GripsFixture === "widths" ? (
      widths()
    ) : (
      <Workspace sidebar={<Text>Ordner</Text>} sidebarWidth={{ min: 200, default: 248 }} sidebarLabel="Breite der Ordner">
        <Pane.Split>
          <Pane label="Liste" width={{ min: 280, default: 360 }}>
            <Text>Nachrichten</Text>
          </Pane>
          <Pane label="Leser">
            <Table
              label="Nachrichten"
              rows={mails}
              columns={[
                { title: "Betreff", width: { min: 120, default: 200 }, cell: (mail) => mail.subject },
                { title: "Von", width: { min: 80, default: 140 }, cell: (mail) => mail.from },
                { title: "Datum", cell: (mail) => mail.date },
              ]}
            />
          </Pane>
          <Pane side label="Angaben" width={{ min: 240, default: 300 }}>
            <Text>Angaben</Text>
          </Pane>
        </Pane.Split>
      </Workspace>
    ),
  root,
);
window.__k2Mounted = true;
