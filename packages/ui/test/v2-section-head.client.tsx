import { render } from "solid-js/web";
import { List, Pane, Row, Section, Table, Text, Workspace } from "../src/v2";

// The section head (Valentin 27.11., settings-headings-study v2, A and B). `window.__k2Case` picks:
// - `form`: a settings screen whose sections are `form` (B where the pane is wide, A where it is narrow), then a list
//   and a table of their own, whose rows draw the subtle lines;
// - `narrow`: the same form section in a pane of 420 px beside another, at a wide window (A: the container decides);
// - `detail`: a detail page with an ordinary section (A at every width).

declare global {
  interface Window {
    __k2Mounted?: boolean;
    __k2Case?: "form" | "narrow" | "detail";
  }
}

const hours = () => (
  <Section
    title="Regelmäßige Öffnungszeiten"
    count="6 Tage"
    summary="Gelten jede Woche, außer an abweichenden Tagen."
    actions={[{ label: "Zeiten", icon: "plus" }]}
  >
    <Row lines={["Montag", "08:00–16:00"]} />
    <Row lines={["Dienstag", "08:00–16:00"]} />
    <Row lines={["Mittwoch", "07:30–16:00 · Lieferung ab 7:30"]} />
  </Section>
);

const shifts = () => (
  <Section title="Schichten" count={5} summary="Wiederkehrende Schichten, für die sich Mitarbeitende eintragen.">
    <Row lines={["Inventur", "Mittwoch · 14:00–17:00 · 2–3 Personen"]} />
    <Row lines={["Mittagstheke", "Donnerstag · 11:00–14:00 · 3–4 Personen"]} />
  </Section>
);

const others = () => (
  <>
    <List label="Abweichungen">
      <Row lines={["Do., 24.12.2026", "Geschlossen · Heiligabend"]} />
      <Row lines={["Do., 31.12.2026", "08:00–12:00 · Silvester"]} />
    </List>
    <Table
      label="Personen"
      rows={[
        { name: "Lea Hoffmann", role: "Admin" },
        { name: "Tom Bauer", role: "Mitarbeit" },
      ]}
      columns={[
        { title: "Name", cell: (row) => row.name },
        { title: "Rolle", cell: (row) => row.role },
      ]}
    />
  </>
);

const root = document.getElementById("root");
if (!root) throw new Error("section head: #root is missing");
const which = window.__k2Case ?? "form";
render(
  () => (
    <Workspace>
      {which === "form" ? (
        <Pane label="Zeiten und Schichten">
          {hours()}
          {shifts()}
          {others()}
        </Pane>
      ) : which === "narrow" ? (
        <Pane.Split>
          <Pane label="Zeiten" width={{ min: 400, default: 420 }}>
            {hours()}
          </Pane>
          <Pane label="Vorschau">
            <Text>Die öffentliche Seite.</Text>
          </Pane>
        </Pane.Split>
      ) : (
        <Pane label="Auftrag">
          <Section
            title="Anstehend"
            count={2}
            summary="Was diese Woche erledigt werden muss."
            actions={[{ label: "Aufgabe", icon: "plus" }]}
          >
            <Row lines={["Quittung wartet auf Unterschrift", "seit 18. Nov."]} />
            <Row lines={["3 Artikel sind abholbereit", "bis 12. Dez."]} />
          </Section>
        </Pane>
      )}
    </Workspace>
  ),
  root,
);
window.__k2Mounted = true;
