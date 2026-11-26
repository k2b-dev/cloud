// Recipe: a record (customer file), first tab. RecordHead in the head bar, the record's areas as tabs over the pane,
// the main column beside a side column with the details. What needs a person comes first ("Anstehend"); every thing
// leads with its mark in the colour of its area, and the people who look after the customer stand with their faces.
import {
  Bar,
  Button,
  Cells,
  Chip,
  Digest,
  Empty,
  Facts,
  Failed,
  List,
  Loading,
  Nav,
  Notice,
  Pane,
  RecordHead,
  Row,
  Section,
  Tabs,
  Text,
  Workspace,
} from "@k2b/ui/v2";

// The app this screen belongs to: its colour tints the page and marks it in the host's rail.
export const app = { color: "#2563eb", icon: "users" };

const area = { money: "#8e1b6f", deliveries: "#c2410c", todo: "#2563eb" };
// One mark per category of article, the same in every list of the app.
const category = {
  clock: { icon: "clock-hour-4", color: "#a16207" },
  chair: { icon: "armchair", color: "#7c3aed" },
  painting: { icon: "palette", color: "#db2777" },
  silver: { icon: "glass-full", color: "#0e7490" },
};
const people = {
  ada: { name: "Ada Renz" },
  lena: { name: "Lena Hartwig" },
  felix: { name: "Felix Thal" },
};

// `empty`: a customer created today, with nothing yet; `loading` and `failed`: the history that loads on its own.
type Props = { empty?: boolean; loading?: boolean; failed?: boolean };

export default function CustomerOverview(props: Props) {
  return (
    <Workspace
      sidebar={
        <Nav
          title="Kunden"
          icon="users"
          groups={[
            {
              items: [
                { label: "Alle Kunden", icon: "users", current: true, count: 412 },
                { label: "Zuletzt", icon: "clock", href: "#zuletzt" },
                { label: "Abholbereit", icon: "packages", count: 9, dot: "warn", href: "#abholbereit" },
              ],
            },
            {
              label: "Listen",
              items: [
                { label: "Privat", icon: "user", color: "#2563eb", count: 318, href: "#privat" },
                { label: "Händler", icon: "building-store", color: "#c2410c", count: 64, href: "#haendler" },
                { label: "Nachlässe", icon: "archive", color: "#7c3aed", count: 30, href: "#nachlaesse" },
              ],
            },
          ]}
        />
      }
      head={
        <Bar
          start={
            <RecordHead
              name="Ottilie Brandner"
              avatar={{ name: "Ottilie Brandner", color: "#1d4ed8" }}
              kinds={["Privat"]}
              ids={[{ label: "Kunde", value: "7K4QX", copy: true }]}
            />
          }
          end={
            <Button variant="primary" icon="plus" menu>
              Neu
            </Button>
          }
        />
      }
      primary={{ label: "Neu", icon: "plus" }}
    >
      <Pane
        label="Kundenakte"
        head={
          <Tabs
            label="Bereiche"
            items={[
              { label: "Überblick", icon: "layout-grid", current: true },
              { label: "Einlieferungen", icon: "package", count: props.empty ? undefined : 4, href: "#einlieferungen" },
              { label: "Geld", icon: "currency-euro", count: props.empty ? undefined : 12, href: "#geld" },
            ]}
          />
        }
      >
        {/* Note and key statements span both columns; the split below holds the main and the side column. */}
        <Notice tone="note" icon="pin" title="Notiz" meta="Ada Renz, 12. Nov." actions={[{ label: "Bearbeiten" }]}>
          Ruft lieber an, als Mails zu schreiben. Abholung nur samstags.
        </Notice>
        <Cells>
          <Cells.Cell
            icon="currency-euro"
            color={area.money}
            label="Geld heute"
            value={props.empty ? "0,00 €" : <Chip amount="out">532,30 €</Chip>}
            meta={props.empty ? "nichts offen" : "1 Rechnung offen"}
            href="#geld"
          />
          <Cells.Cell
            icon="package"
            color={area.deliveries}
            label="Einlieferungen"
            value={props.empty ? "keine" : "2 laufen"}
            meta={props.empty ? undefined : "Abrechnung am 15. Dez."}
            href="#einlieferungen"
          />
          <Cells.Cell icon="file-text" label="Vertrag" value={<Chip status="ok">Gültig</Chip>} meta="bis 31. Dez. 2027" />
        </Cells>
        <Pane.Split>
          <Pane label="Überblick">
            <Section
              icon="checklist"
              color={area.todo}
              title="Anstehend"
              count={props.empty ? undefined : 2}
              actions={[{ label: "Todo anlegen", icon: "plus" }]}
            >
              {props.empty ? (
                <Empty icon="checks" text="Für diesen Kunden steht nichts an." />
              ) : (
                <>
                  <Row
                    yours
                    strong
                    mark={{ icon: "signature", color: area.todo }}
                    lines={["Quittung wartet auf Unterschrift", "Q-2611-00021 · seit 18. Nov."]}
                    action={{ label: "Zur Quittung" }}
                  />
                  <Row
                    strong
                    mark={{ icon: "packages", color: area.deliveries }}
                    lines={["3 Artikel sind abholbereit", "bis 12. Dez."]}
                    action={{ label: "Herausgabe vorbereiten" }}
                  />
                </>
              )}
            </Section>
            {/* The history loads on its own: its states stand in this section, the rest of the record stays. */}
            <Section
              icon="list-details"
              color={area.deliveries}
              title="Vorgänge"
              more={props.empty || props.failed ? undefined : { label: "Alle Einlieferungen", forward: true }}
            >
              {props.failed ? (
                <Failed
                  text="Die Vorgänge konnten nicht geladen werden. Die übrige Akte bleibt, wie sie ist."
                  onRetry={() => location.reload()}
                />
              ) : props.loading ? (
                <Loading rows={2} lines={2} />
              ) : props.empty ? (
                <Empty icon="package" text="Noch keine Einlieferung." action={{ label: "Einlieferung erfassen", icon: "plus" }} />
              ) : (
                <Digest
                  items={[
                    {
                      icon: "package",
                      color: area.deliveries,
                      date: "3. Nov.",
                      title: "EL-2611-00009",
                      state: { icon: "gavel", label: "Läuft" },
                      text: (
                        <>
                          8 Artikel laufen, die Auktion endet <Text weight="strong">morgen</Text>.
                        </>
                      ),
                    },
                    {
                      icon: "package",
                      color: area.deliveries,
                      date: "14. Okt.",
                      title: "EL-2610-00031",
                      state: { icon: "check", label: "Abgerechnet", tone: "ok" },
                      text: "Ausgezahlt am 15. Nov.",
                    },
                  ]}
                />
              )}
            </Section>
            <Section
              icon="armchair"
              title="Im Haus"
              count={props.empty ? undefined : 8}
              more={props.empty ? undefined : { label: "Alle Artikel", forward: true }}
            >
              {props.empty ? (
                <Empty icon="armchair" text="Noch kein Artikel im Haus." />
              ) : (
                <List label="Im Haus">
                  <Row
                    mark={category.clock}
                    lines={["Standuhr, Schwarzwald um 1880", "EL-2611-00009 · Auktion endet morgen"]}
                    time="Gebot 1.450 €"
                    marks={<Chip status="ok">7 Gebote</Chip>}
                    href="#a-1"
                  />
                  <Row
                    mark={category.chair}
                    lines={["Biedermeier-Sessel, Paar", "EL-2611-00009 · im Katalog"]}
                    time="Schätzung 900 €"
                    href="#a-2"
                  />
                  <Row
                    mark={category.painting}
                    lines={["Ölbild „Rheinauen“, signiert", "EL-2611-00009 · Fotos fehlen"]}
                    time="Schätzung 600 €"
                    marks={<Chip status="warn">Ohne Fotos</Chip>}
                    href="#a-3"
                  />
                  <Row
                    mark={category.silver}
                    lines={["Silberbesteck, 84 Teile", "EL-2611-00009 · abholbereit"]}
                    time="verkauft 2.100 €"
                    href="#a-4"
                  />
                </List>
              )}
            </Section>
          </Pane>
          <Pane side label="Angaben" width={{ min: 280, default: 360 }}>
            <Section
              icon="phone"
              title="Kontakt"
              actions={[{ label: "Ändern", icon: "pencil" }]}
              more={{ label: "Alle Angaben", meta: "Bank, Person" }}
            >
              <Facts
                items={[
                  { label: "Telefon", value: "+49 30 5550 142", hint: "Standard", copy: "+49 30 5550 142" },
                  { label: "E-Mail", value: "o.brandner@example.de", copy: "o.brandner@example.de" },
                  { label: "Adresse", value: "Lindenallee 14, 77933 Lahr" },
                  { label: "Sprache", value: "Deutsch" },
                ]}
              />
            </Section>
            <Section icon="users" title="Betreut von" count={2}>
              <List label="Betreut von">
                <Row avatar={people.ada} lines={["Ada Renz", "Beratung und Verträge"]} />
                <Row avatar={people.lena} lines={["Lena Hartwig", "Fotos und Katalog"]} />
              </List>
            </Section>
            <Section icon="activity" title="Aktivität" count="diese Woche">
              {props.empty ? (
                <Empty icon="activity" text="Hier steht, wer was an dieser Akte getan hat." />
              ) : (
                <Digest
                  label="Aktivität"
                  activity={[
                    {
                      person: people.felix,
                      text: (
                        <>
                          <Text weight="strong">Felix Thal</Text> hat ein Gebot für die <Text weight="strong">Standuhr</Text> angenommen
                        </>
                      ),
                      time: "heute, 09:12",
                    },
                    {
                      person: people.ada,
                      text: (
                        <>
                          <Text weight="strong">Ada Renz</Text> hat die Notiz geändert
                        </>
                      ),
                      time: "12. Nov.",
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
  empty: () => <CustomerOverview empty />,
  loading: () => <CustomerOverview loading />,
  failed: () => <CustomerOverview failed />,
};
