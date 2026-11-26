// Recipe: the home of one place (a base, a project): its key numbers with a short history, then its things grouped
// as they are arranged, each with its mark, its figures and its state, then who changed what.
import { Bar, Button, Cells, Chip, Digest, Input, Mark, Nav, Pane, Row, Section, Tabs, Text, Workspace } from "@k2b/ui/v2";

// The app this screen belongs to: its colour tints the page and marks it in the host's rail.
export const app = { name: "Grids", color: "#047857", icon: "table" };

// Each kind of thing has one colour, so a table looks like a table in the sidebar, in a row and in a sentence.
const kind = {
  table: { icon: "table", color: "#008f4c" },
  form: { icon: "forms", color: "#c2410c" },
  workflow: { icon: "bolt", color: "#7c3aed" },
  app: { icon: "app-window", color: "#be185d" },
  document: { icon: "file-text", color: "#2563eb" },
};

// `quiet`: a day without anything that needs a person.
type Props = { quiet?: boolean };

export default function PlaceHome(props: Props) {
  return (
    <Workspace
      sidebar={
        <Nav
          title="Werkstatt"
          icon="tool"
          groups={[
            {
              items: [
                { label: "Übersicht", icon: "layout-grid", current: true },
                { label: "Abfrage", icon: "code" },
              ],
            },
            {
              label: "Annahme",
              items: [
                { label: "Aufträge", ...kind.table, count: 128 },
                { label: "Auftrag annehmen", ...kind.form, dot: props.quiet ? undefined : "ok" },
              ],
            },
            {
              label: "Teile & Lager",
              items: [
                { label: "Ersatzteile", ...kind.table, count: 642 },
                { label: "Nachbestellung", ...kind.workflow, dot: props.quiet ? undefined : "bad" },
              ],
            },
            {
              label: "Planung",
              items: [
                { label: "Termine", ...kind.table, count: 86 },
                { label: "Tagesplan", ...kind.app },
              ],
            },
            {
              label: "Auswertung",
              items: [
                { label: "Monatsbericht", ...kind.document },
                { label: "Rechnung erzeugen", ...kind.workflow },
              ],
            },
          ]}
          foot={[
            { label: "Bearbeiten", icon: "pencil" },
            { label: "Einstellungen", icon: "settings" },
          ]}
        />
      }
      head={
        <Bar
          start={
            <Tabs
              label="Ansichten"
              items={[
                { label: "Übersicht", current: true },
                { label: "Alle Ressourcen", count: 14, href: "#alle" },
                { label: "Aktivität", href: "#aktivitaet" },
              ]}
            />
          }
          end={
            <>
              <Input type="search" icon="search" label="In Werkstatt suchen" placeholder="In Werkstatt suchen" />
              <Button variant="primary" icon="plus" menu>
                Neu
              </Button>
            </>
          }
        />
      }
      primary={{ label: "Neu", icon: "plus" }}
    >
      <Pane label="Übersicht">
        <Cells>
          <Cells.Cell
            icon="clipboard-list"
            color={kind.table.color}
            label="Offene Aufträge"
            value="41"
            meta="+12 heute · 7 über das Formular"
            trend={{ values: [22, 30, 27, 36, 31, 38, 41], label: "Offene Aufträge: in 7 Tagen von 22 auf 41 gestiegen" }}
            href="#offen"
          />
          <Cells.Cell
            icon="calendar-due"
            label="Heute fällig"
            // the number stands as a number; what needs a person stands beside it as a tinted chip
            value={
              props.quiet ? (
                "4"
              ) : (
                <>
                  9 <Chip status="warn">3 offen</Chip>
                </>
              )
            }
            meta="3 ohne Monteur · nächster 10:30"
          />
          <Cells.Cell
            icon="package"
            color={kind.table.color}
            label="Ersatzteile knapp"
            value={
              props.quiet ? (
                "0"
              ) : (
                <>
                  8 <Chip status="warn">bestellen</Chip>
                </>
              )
            }
            meta="Scharniere, Griffe, Kantenband"
          />
          <Cells.Cell
            icon="bolt"
            color={kind.workflow.color}
            label="Workflows"
            value={
              props.quiet ? (
                <>
                  3 <Chip status="ok">laufen</Chip>
                </>
              ) : (
                <>
                  3 <Chip status="bad">1 Fehler</Chip>
                </>
              )
            }
            meta={props.quiet ? "zuletzt 09:41" : "Nachbestellung · heute 06:00"}
          />
        </Cells>
        {/* the groups of the place side by side, as they are arranged in the sidebar */}
        <Section.Columns>
          <Section title="Annahme" count={3} actions={[{ label: "Neu in Annahme", icon: "plus" }]}>
            <Row
              strong
              mark={kind.table}
              lines={["Aufträge", "128 Einträge · Offen 41 · Kanban · Kalender"]}
              marks={<Chip status="ok">+12 heute</Chip>}
              href="#auftraege"
            />
            <Row
              strong
              mark={kind.form}
              lines={["Auftrag annehmen", "Formular → Aufträge · öffentlich"]}
              marks={props.quiet ? undefined : <Chip yours>7 neu</Chip>}
              href="#formular"
            />
            <Row
              strong
              mark={kind.workflow}
              lines={["Eingangsbestätigung", "Workflow · bei neuem Auftrag · Mail an Kunden"]}
              marks={<Chip status="ok">läuft · 09:41</Chip>}
              href="#bestaetigung"
            />
          </Section>
          <Section title="Teile & Lager" count={3} actions={[{ label: "Neu in Teile & Lager", icon: "plus" }]}>
            <Row
              strong
              mark={kind.table}
              lines={["Ersatzteile", "642 Einträge · Nachbestellen 8 · Nach Lieferant"]}
              marks={<Chip status="warn">8 knapp</Chip>}
              href="#ersatzteile"
            />
            <Row strong mark={kind.table} lines={["Lieferanten", "37 Einträge · Aktiv 21"]} time="Mo." href="#lieferanten" />
            <Row
              strong
              mark={kind.workflow}
              lines={["Nachbestellung", "Workflow · täglich 06:00 · Lieferant nicht erreichbar"]}
              marks={props.quiet ? <Chip status="ok">läuft</Chip> : <Chip status="bad">Fehler · 06:00</Chip>}
              href="#nachbestellung"
            />
          </Section>
          <Section title="Planung" count={3} actions={[{ label: "Neu in Planung", icon: "plus" }]}>
            <Row
              strong
              mark={kind.table}
              lines={["Termine", "86 Einträge · Woche · Nach Monteur · Kalender"]}
              marks={<Chip yours>9 heute</Chip>}
              href="#termine"
            />
            <Row strong mark={kind.table} lines={["Monteure", "6 Einträge · 4 im Einsatz"]} time="12.11." href="#monteure" />
            <Row
              strong
              mark={kind.app}
              lines={["Tagesplan", "App · für Monteure am Telefon"]}
              marks={<Chip status="ok">veröffentlicht</Chip>}
              href="#tagesplan"
            />
          </Section>
          <Section title="Auswertung" count={3} actions={[{ label: "Neu in Auswertung", icon: "plus" }]}>
            <Row
              strong
              mark={kind.table}
              lines={["Umsatz je Monteur", "Ansicht von Aufträge · gruppiert, Summe"]}
              time="gestern"
              href="#umsatz"
            />
            <Row
              strong
              mark={kind.document}
              lines={["Monatsbericht", "Dokumentvorlage · PDF aus Aufträge"]}
              time="01.11."
              href="#bericht"
            />
            <Row
              strong
              mark={kind.workflow}
              lines={["Rechnung erzeugen", "Workflow · von Hand gestartet"]}
              marks={<Chip>Entwurf</Chip>}
              href="#rechnung"
            />
          </Section>
        </Section.Columns>
        <Section title="Zuletzt geändert" more={{ label: "Alle Aktivitäten", forward: true }}>
          <Digest
            label="Zuletzt geändert"
            activity={[
              {
                person: { name: "Felix Thal" },
                text: (
                  <>
                    <Text weight="strong">Felix Thal</Text> hat <Text weight="strong">Küche Lindqvist</Text> in <Mark {...kind.table} />
                    <Text weight="strong">Aufträge</Text> auf „In Arbeit“ gesetzt
                  </>
                ),
                time: "09:42",
              },
              {
                person: { name: "Webformular", initials: "W", color: "#475569" },
                text: (
                  <>
                    <Mark {...kind.form} />
                    <Text weight="strong">Auftrag annehmen</Text> hat „Bad Oswald, Waschtisch“ angelegt
                  </>
                ),
                time: "09:38",
              },
              {
                person: { name: "Jonas Kern" },
                text: (
                  <>
                    <Text weight="strong">Jonas Kern</Text> hat 6 Termine in <Mark {...kind.table} />
                    <Text weight="strong">Termine</Text> auf Donnerstag verschoben
                  </>
                ),
                time: "08:57",
              },
            ]}
          />
        </Section>
      </Pane>
    </Workspace>
  );
}

// The app the screen belongs to (Grids): its colour and symbol, for the frame of a host around its pictures.
export const app = { color: "#008f4c", icon: "table" };

// The states that Fibel's Example offers beside the default; the recipe test renders each one as well.
export const states = {
  quiet: () => <PlaceHome quiet />,
};
