import { render } from "solid-js/web";
import { Pane, Section, Table, Workspace } from "../src/v2";

// Which column of a table takes the room that is left, and what a table does that is wider than its pane (W3, Spaces
// admin): "Bereiche" lets its text column grow (the widest that is not a number), "Mitglieder" names the column that
// grows (`grow`), and "Termine" needs more room than a pane of 1024 px has, so it scrolls sideways and says so.

declare global {
  interface Window {
    __k2Mounted?: boolean;
  }
}

const areas = [
  {
    id: "1",
    name: "Werkstatt",
    description: "Alles rund um die Werkstatt: Aufträge, Material, Termine mit Kundinnen und Kunden und die Pläne der Woche",
    settings: "Öffentlich",
  },
  { id: "2", name: "Lager", description: "Bestand, Lieferungen und Inventur", settings: "Nur Mitglieder" },
];
const members = [
  { id: "1", name: "Maximiliane Theodora von Hohenzollern-Sigmaringen", role: "Leitung", note: "Vertritt die Werkstatt" },
  { id: "2", name: "Jonas Wille", role: "Mitglied", note: "Lager und Inventur" },
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

const root = document.getElementById("root");
if (!root) throw new Error("table-columns: #root is missing");
render(
  () => (
    <Workspace>
      <Pane label="Spaces">
        <Section title="Bereiche">
          <Table
            label="Bereiche"
            rows={areas}
            rowKey={(area) => area.id}
            columns={[
              { title: "Name", width: { min: 160, default: 200 }, cell: (area) => area.name },
              { title: "Beschreibung", width: { min: 200, default: 250 }, cell: (area) => area.description },
              { title: "Einstellungen", width: { min: 100, default: 140 }, cell: (area) => area.settings },
            ]}
          />
        </Section>
        <Section title="Mitglieder">
          <Table
            label="Mitglieder"
            rows={members}
            rowKey={(member) => member.id}
            columns={[
              { title: "Name", width: { min: 200, default: 220 }, grow: true, cell: (member) => member.name },
              { title: "Rolle", width: { min: 100, default: 140 }, cell: (member) => member.role },
              { title: "Notiz", width: { min: 200, default: 300 }, cell: (member) => member.note },
            ]}
          />
        </Section>
        <Section title="Termine">
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
        </Section>
      </Pane>
    </Workspace>
  ),
  root,
);
window.__k2Mounted = true;
