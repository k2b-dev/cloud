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
  {
    id: "1",
    name: "Maximiliane Theodora von Hohenzollern-Sigmaringen",
    role: "Leitung",
    note: "Vertritt die Werkstatt bei allen Terminen mit der Innung, der Handwerkskammer und den Lieferanten",
  },
  { id: "2", name: "Jonas Wille", role: "Mitglied", note: "Lager und Inventur" },
];
const keys = [{ id: "1", name: "Werkstatt-Export", prefix: "k2_live_8f3a…", used: "vor 3 Minuten" }];
const people = [{ id: "1", name: "Anna Brandt", mail: "anna.brandt@werkstatt.example", role: "Leitung" }];
const places = [{ id: "1", name: "Werkstatt", hall: "Halle 2", note: "Zufahrt über den Hof, Schlüssel beim Pförtner" }];
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
        {/* a column without a width is the one the author left open: it grows */}
        <Section title="Schlüssel">
          <Table
            label="Schlüssel"
            rows={keys}
            rowKey={(key) => key.id}
            columns={[
              { title: "Name", width: { min: 160, default: 200 }, cell: (key) => key.name },
              { title: "Präfix", cell: (key) => key.prefix },
              { title: "Zuletzt genutzt", width: { min: 200, default: 320 }, cell: (key) => key.used, drop: true },
            ]}
          />
        </Section>
        {/* the widest column may drop: the widest that stays grows instead */}
        <Section title="Personen">
          <Table
            label="Personen"
            rows={people}
            rowKey={(person) => person.id}
            columns={[
              { title: "Name", width: { min: 160, default: 200 }, cell: (person) => person.name },
              { title: "E-Mail", width: { min: 200, default: 300 }, cell: (person) => person.mail, drop: true },
              { title: "Rolle", width: { min: 100, default: 140 }, cell: (person) => person.role },
            ]}
          />
        </Section>
        {/* an open last column grows, and never below the smallest min of the others: a narrow table scrolls instead */}
        <Section title="Orte">
          <Table
            label="Orte"
            rows={places}
            rowKey={(place) => place.id}
            columns={[
              { title: "Name", width: { min: 160, default: 200 }, cell: (place) => place.name },
              { title: "Halle", width: { min: 120, default: 160 }, cell: (place) => place.hall },
              { title: "Notiz", cell: (place) => place.note },
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
