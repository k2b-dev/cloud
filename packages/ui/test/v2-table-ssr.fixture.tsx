import { Pane, Table, Workspace } from "../src/v2";

// Two tables as the server sends them and the browser hydrates them (test/v2-table-ssr.server.tsx and .client.tsx):
// Files' list, whose columns that may drop give way by the table's width, and a list of dates wider than a narrow
// pane, which scrolls sideways. What the server sends is what the first frame shows: the same columns, the same
// height with a real scrollbar.

const files = [
  { id: "1", name: "Angebot Küchenfront.pdf", changed: "26. Nov. 2026, 09:12", owner: "Anna Brandt", size: "4,2 MB" },
  { id: "2", name: "Fotos Baustelle", changed: "24. Nov. 2026, 08:03", owner: "Jonas Wille", size: "1,4 GB" },
];
const dates = [
  {
    id: "1",
    title: "Jahresabschluss",
    span: "Do., 31. Dez., 20:00 – Fr., 1. Jan., 02:00",
    place: "Werkstatt, Halle 2",
    lead: "Anna Brandt",
    note: "Bitte Getränke mitbringen",
  },
];

export const Fixture = () => (
  <Workspace>
    <Pane label="Tabellen">
      <Table
        label="Dateien"
        rows={files}
        rowKey={(file) => file.id}
        columns={[
          { title: "Name", width: { min: 200, default: 280 }, cell: (file) => file.name },
          { title: "Geändert", width: { min: 140, default: 170 }, cell: (file) => file.changed, drop: true },
          { title: "Besitzer", width: { min: 120, default: 220 }, cell: (file) => file.owner, drop: true },
          { title: "Größe", align: "end", width: { min: 90, default: 100 }, cell: (file) => file.size },
        ]}
      />
      <Table
        label="Termine"
        rows={dates}
        rowKey={(date) => date.id}
        columns={[
          { title: "Titel", width: { min: 200, default: 240 }, cell: (date) => date.title },
          { title: "Zeitraum", width: { min: 300, default: 320 }, cell: (date) => date.span },
          { title: "Ort", width: { min: 180, default: 220 }, cell: (date) => date.place },
          { title: "Leitung", width: { min: 160, default: 200 }, cell: (date) => date.lead },
          { title: "Notiz", width: { min: 160, default: 220 }, cell: (date) => date.note },
        ]}
      />
    </Pane>
  </Workspace>
);
