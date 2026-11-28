import { render } from "solid-js/web";
import { List, Pane, Row, Section, Table, Text, Workspace } from "../src/v2";

// The section head (Valentin 27.11., settings-headings-study v2, A and B). `window.__k2SectionCase` picks:
// - `form`: a settings screen whose sections are B where the pane is wide and A where it is narrow, then a list
//   and a table of their own, whose rows draw the subtle lines;
// - `narrow`: the same form section in a pane of 420 px beside another, at a wide window (A: the container decides);
// - `detail`: a detail page whose one section holds a large table (A at every width, its full width, no line under it).

declare global {
  interface Window {
    __k2Mounted?: boolean;
    __k2SectionCase?: "form" | "narrow" | "detail" | "custom";
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
const which = window.__k2SectionCase ?? "form";
render(
  () => (
    <Workspace>
      {which === "custom" ? (
        // an app's own part, a plain element with no primitive behind it, straight in a section and in a folding one
        <Pane label="Eigenes">
          <Section title="Eigene Teile" summary="Ein Teil der App ohne Primitive.">
            <div data-probe="custom" style={{ height: "24px", "border-bottom": "1px solid #e4e4e7" }}>
              Eigenes
            </div>
            <Row lines={["Montag", "08:00–16:00"]} />
          </Section>
          <Section title="Gefaltet" onOpenChange={() => undefined}>
            <div data-probe="custom-folded" style={{ height: "24px", "border-bottom": "1px solid #e4e4e7" }}>
              Eigenes im Körper
            </div>
          </Section>
        </Pane>
      ) : which === "form" ? (
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
            <Table
              label="Aufgaben"
              sticky
              rows={[{ name: "Quittung", due: "18. Nov." }]}
              columns={[
                { title: "Aufgabe", cell: (row) => row.name },
                { title: "Fällig", cell: (row) => row.due },
              ]}
            />
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
