import { render } from "solid-js/web";
import { Pane, Table, Text, Workspace } from "../src/v2";

// A mail workspace in short: a sidebar (200..248), a list (280..360) beside a reader that keeps 400, and an info
// column on the right (240..300); the reader holds a table whose first two columns have widths (120..200, 80..140).
// In a 1400 px window: sidebar 248 | list 360 | reader 488 | info 300.

declare global {
  interface Window {
    __k2Mounted?: boolean;
  }
}

type Mail = { subject: string; from: string; date: string };
const mails: Mail[] = [
  { subject: "Angebot Eichenplatten", from: "Holzhandel Brandner", date: "24.11." },
  { subject: "Lieferung Freitag", from: "Spedition Kolb", date: "23.11." },
];

const root = document.getElementById("root");
if (!root) throw new Error("grips: #root is missing");
render(
  () => (
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
