// Recipe: an overview of things that each have a face (the bases of Grids, the projects of a team). Each thing leads
// with its mark in the sidebar, on its card and in its rows; people stand beside what they did.
import {
  Bar,
  Button,
  Chip,
  Digest,
  Empty,
  Input,
  List,
  Mark,
  Nav,
  Pane,
  Row,
  Section,
  StatusRow,
  Tabs,
  Text,
  Tiles,
  Workspace,
} from "@k2b/ui/v2";

// The app this screen belongs to: its colour tints the page and marks it in the host's rail.
export const app = { color: "#047857", icon: "table" };

// The data colour and symbol of each base, the same in the sidebar, on the card and in a sentence.
const base = {
  workshop: { icon: "tool", color: "#c2410c" },
  customers: { icon: "users", color: "#2563eb" },
  stock: { icon: "building-warehouse", color: "#0f766e" },
  staff: { icon: "id-badge-2", color: "#7c3aed" },
  money: { icon: "coin-euro", color: "#15803d" },
  events: { icon: "confetti", color: "#db2777" },
};
// Each kind of thing in a base has one colour, so a table looks like a table everywhere.
const kind = {
  table: { icon: "table", color: "#008f4c" },
  board: { icon: "layout-kanban", color: "#0e7490" },
  form: { icon: "forms", color: "#c2410c" },
  workflow: { icon: "bolt", color: "#7c3aed" },
};
const people = {
  felix: { name: "Felix Thal" },
  jonas: { name: "Jonas Kern" },
  mira: { name: "Mira Solberg" },
  ada: { name: "Ada Renz" },
  jana: { name: "Jana Berger" },
  sami: { name: "Sami Yilmaz" },
  lena: { name: "Lena Hartwig" },
  tom: { name: "Tom Oswald" },
};

// `empty`: a new installation without a base yet.
type Props = { empty?: boolean };

export default function BasesOverview(props: Props) {
  return (
    <Workspace
      sidebar={
        <Nav
          title="Grids"
          icon="table"
          groups={[
            {
              items: [
                { label: "Übersicht", icon: "layout-grid", current: true },
                { label: "Apps", icon: "apps", count: 4 },
              ],
            },
            {
              label: "Bases",
              action: { label: "Neue Base", icon: "plus" },
              items: props.empty
                ? []
                : [
                    { label: "Werkstatt", ...base.workshop },
                    { label: "Kunden & Aufträge", ...base.customers },
                    { label: "Lager Nord", ...base.stock, dot: "warn" },
                    { label: "Personal", ...base.staff },
                    { label: "Finanzen 2027", ...base.money },
                    { label: "Veranstaltungen", ...base.events },
                  ],
            },
          ]}
          foot={[
            { label: "Vorlagen", icon: "template" },
            { label: "Papierkorb", icon: "trash" },
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
                { label: "Alle Bases", count: props.empty ? undefined : 6, href: "#alle" },
                { label: "Apps", count: 4, href: "#apps" },
              ]}
            />
          }
          end={
            <>
              <Input type="search" icon="search" label="Bases und Tabellen" placeholder="Bases und Tabellen" />
              <Button variant="primary" icon="plus">
                Neue Base
              </Button>
            </>
          }
        />
      }
      primary={{ label: "Neue Base", icon: "plus" }}
    >
      <Pane
        label="Übersicht"
        status={
          props.empty ? undefined : (
            <StatusRow
              lead="318 Änderungen heute"
              facts={[{ value: 5, after: "Bases" }]}
              filters={
                <>
                  <Chip yours icon="forms">
                    12 neue Einträge
                  </Chip>
                  <Chip status="bad">Nachbestellung fehlgeschlagen</Chip>
                </>
              }
            />
          )
        }
      >
        <Pane.Split>
          <Pane label="Bases">
            <Section
              title="Zuletzt genutzt"
              count={props.empty ? undefined : "5 von 6"}
              more={props.empty ? undefined : { label: "Alle Bases", forward: true }}
            >
              <Tiles
                variant="card"
                label="Bases"
                items={
                  props.empty
                    ? []
                    : [
                        {
                          ...base.workshop,
                          title: "Werkstatt",
                          meta: "Aufträge, Ersatzteile und Termine",
                          href: "#werkstatt",
                          stats: [
                            { icon: "table", label: "6 Tabellen" },
                            { icon: "forms", label: "2 Formulare" },
                          ],
                          people: [people.felix, people.jonas, people.mira, people.tom, people.sami],
                          foot: "Felix · vor 2 Min",
                          trend: { values: [12, 22, 16, 28, 20, 34, 41], label: "Änderungen der letzten 7 Tage" },
                        },
                        {
                          ...base.customers,
                          title: "Kunden & Aufträge",
                          meta: "CRM mit Angeboten und Rechnungen",
                          href: "#kunden",
                          stats: [
                            { icon: "table", label: "9 Tabellen" },
                            { icon: "file-text", label: "4 Vorlagen" },
                          ],
                          people: [people.ada, people.jana, people.mira, people.felix],
                          foot: "Ada · vor 14 Min",
                          trend: { values: [30, 41, 33, 45, 38, 9, 36], label: "Änderungen der letzten 7 Tage" },
                        },
                        {
                          ...base.stock,
                          title: "Lager Nord",
                          meta: "Bestand, Einlieferungen, Inventur",
                          href: "#lager",
                          stats: [
                            { icon: "table", label: "7 Tabellen" },
                            { icon: "alert-circle", label: "8 knapp", status: "warn" },
                          ],
                          people: [people.sami, people.felix],
                          foot: "Sami · vor 1 Std",
                          trend: { values: [14, 12, 18, 16, 10, 4, 20], label: "Änderungen der letzten 7 Tage" },
                        },
                        {
                          ...base.staff,
                          title: "Personal",
                          meta: "Urlaub, Schichten und Schulungen",
                          href: "#personal",
                          stats: [
                            { icon: "table", label: "5 Tabellen" },
                            { label: "3 Anträge", yours: true },
                          ],
                          people: [people.lena, people.mira],
                          foot: "Lena · gestern",
                          trend: { values: [8, 10, 6, 12, 8, 2, 14], label: "Änderungen der letzten 7 Tage" },
                        },
                        {
                          ...base.money,
                          title: "Finanzen 2027",
                          meta: "Budget, Konten, Belege",
                          href: "#finanzen",
                          stats: [
                            { icon: "table", label: "6 Tabellen" },
                            { icon: "lock", label: "3 Personen" },
                          ],
                          people: [people.ada, people.mira, people.tom],
                          foot: "Ada · Mo.",
                          trend: { values: [4, 6, 4, 16, 5, 2, 9], label: "Änderungen der letzten 7 Tage" },
                        },
                      ]
                }
                create={{
                  title: "Neue Base",
                  meta: "Leer beginnen oder aus einer Vorlage",
                  href: "#neu",
                  choices: [{ label: "CRM" }, { label: "Lager" }, { label: "Personal" }, { label: "Leer" }],
                }}
              />
            </Section>
            <Section title="Zuletzt geöffnet" count={props.empty ? undefined : 4}>
              {props.empty ? (
                <Empty icon="table" text="Noch nichts geöffnet. Eine neue Base bringt ihre ersten Tabellen mit." />
              ) : (
                <List label="Zuletzt geöffnet">
                  <Row
                    mark={kind.table}
                    lines={["Aufträge", "Werkstatt · 128 Einträge"]}
                    time="vor 2 Min"
                    marks={<Chip status="ok">+12 heute</Chip>}
                    href="#auftraege"
                  />
                  <Row
                    mark={kind.board}
                    lines={["Angebote · Pipeline", "Kunden & Aufträge · 54 Einträge"]}
                    time="vor 14 Min"
                    href="#pipeline"
                  />
                  <Row
                    mark={kind.table}
                    lines={["Ersatzteile", "Werkstatt · 642 Einträge"]}
                    time="vor 1 Std"
                    marks={<Chip status="warn">8 knapp</Chip>}
                    href="#ersatzteile"
                  />
                  <Row mark={kind.form} lines={["Urlaubsantrag", "Personal · 31 Einträge"]} time="gestern" href="#urlaub" />
                </List>
              )}
            </Section>
          </Pane>
          <Pane side label="Aktivität" width={{ min: 280, default: 340 }}>
            <Section title="Aktivität" count="heute" more={{ label: "Alle Aktivitäten", forward: true }}>
              {props.empty ? (
                <Empty icon="activity" text="Hier steht, wer was geändert hat." />
              ) : (
                <Digest
                  label="Aktivität"
                  activity={[
                    {
                      person: people.felix,
                      text: (
                        <>
                          <Text weight="strong">Felix Thal</Text> hat 3 Einträge in <Mark {...kind.table} />
                          <Text weight="strong">Aufträge</Text> geändert
                        </>
                      ),
                      place: "Werkstatt",
                      time: "09:42",
                      href: "#auftraege",
                    },
                    {
                      person: { name: "Webformular", initials: "W", color: "#475569" },
                      text: (
                        <>
                          Neuer Eintrag über <Mark {...kind.form} />
                          <Text weight="strong">Auftrag annehmen</Text>: „Küche Lindqvist, Aufmaß“
                        </>
                      ),
                      place: "Werkstatt",
                      time: "09:38",
                    },
                    {
                      person: people.ada,
                      text: (
                        <>
                          <Text weight="strong">Ada Renz</Text> hat 2 Angebote in <Mark {...kind.board} />
                          <Text weight="strong">Pipeline</Text> gewonnen
                        </>
                      ),
                      place: "Kunden & Aufträge",
                      time: "09:28",
                    },
                    {
                      person: { name: "Nachbestellung", initials: "N", color: kind.workflow.color },
                      text: (
                        <>
                          <Mark {...kind.workflow} />
                          <Text weight="strong">Nachbestellung</Text> ist fehlgeschlagen: Lieferant nicht erreichbar
                        </>
                      ),
                      place: "Lager Nord",
                      time: "06:00",
                    },
                    {
                      person: people.lena,
                      text: (
                        <>
                          <Text weight="strong">Lena Hartwig</Text> hat 3 Urlaubsanträge genehmigt
                        </>
                      ),
                      place: "Personal",
                      time: "gestern, 16:40",
                    },
                  ]}
                />
              )}
            </Section>
          </Pane>
        </Pane.Split>
      </Pane>
    </Workspace>
  );
}

// The states that Fibel's Example offers beside the default; the recipe test renders each one as well.
export const states = {
  empty: () => <BasesOverview empty />,
};
