// Recipe: a record tab with groups. A Band in a tone carries the one statement of the tab; one Section for the area;
// one Group per thing that belongs together (here a delivery). A finished one is folded to its head. Inside a group: a
// sentence, its way, its articles with their marks, a table, facts; no lines, no nesting.
import {
  Band,
  Bar,
  Button,
  Chip,
  Empty,
  Facts,
  Failed,
  Group,
  Inline,
  List,
  Loading,
  Mark,
  Nav,
  Pane,
  Progress,
  RecordHead,
  Row,
  Section,
  Steps,
  Table,
  Tabs,
  Text,
  Workspace,
} from "@k2b/ui/v2";

// The app this screen belongs to: its colour tints the page and marks it in the host's rail.
export const app = { color: "#2563eb", icon: "users" };

const delivery = { icon: "package", color: "#c2410c" };
const settlement = { icon: "calendar-dollar", color: "#8e1b6f" };
// One mark per category of article, the same in every list of the app.
const category = {
  clock: { icon: "clock-hour-4", color: "#a16207" },
  chair: { icon: "armchair", color: "#7c3aed" },
  painting: { icon: "palette", color: "#db2777" },
  silver: { icon: "glass-full", color: "#0e7490" },
};

type Settlement = { day: string; items: string; when: string; workday: number; amount: string; estimate: boolean };

const settlements: Settlement[] = [
  { day: "15. Nov.", items: "10 Artikel", when: "15. Dez.", workday: 5, amount: "180,00 €", estimate: true },
  { day: "24. Nov.", items: "8 Artikel", when: "15. Jan.", workday: 0, amount: "offen", estimate: false },
];

// `empty`: a customer without a delivery yet; `loading` and `failed`: the deliveries of this tab.
type Props = { empty?: boolean; loading?: boolean; failed?: boolean };

export default function CustomerDeliveries(props: Props) {
  const ready = !props.empty && !props.loading && !props.failed;
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
              ids={[{ label: "Kunde", value: "7K4QX" }]}
            />
          }
          end={
            <Button variant="primary" icon="plus">
              Einlieferung
            </Button>
          }
        />
      }
      primary={{ label: "Einlieferung", icon: "plus" }}
    >
      <Pane
        label="Kundenakte"
        head={
          <Tabs
            label="Bereiche"
            items={[
              { label: "Überblick", icon: "layout-grid", href: "#" },
              { label: "Einlieferungen", icon: "package", count: ready ? 3 : undefined, current: true },
              { label: "Geld", icon: "currency-euro", count: ready ? 12 : undefined, href: "#geld" },
            ]}
          />
        }
      >
        {/* One statement that stands out in the column: a band in a tone, not a message with a title and deeds. */}
        {ready && (
          <Band tone="note">
            <Text type="body" weight="strong">
              Die nächste Abrechnung kommt am 15. Dez.
            </Text>
            <Text>Geschätzt 180,00 € für 10 Artikel.</Text>
          </Band>
        )}
        <Section
          icon="package"
          color="#c2410c"
          title="Einlieferungen"
          count={ready ? 3 : undefined}
          actions={[{ label: "Herausgabe", icon: "package-export" }]}
          summary={ready ? "18 Artikel laufen, 10 sind ausgelaufen." : undefined}
        >
          {props.failed ? (
            <Failed text="Die Einlieferungen konnten nicht geladen werden. Die Akte bleibt offen." onRetry={() => location.reload()} />
          ) : props.loading ? (
            <Loading rows={6} lines={2} />
          ) : props.empty ? (
            <Empty icon="package" text="Noch keine Einlieferung." action={{ label: "Einlieferung erfassen", icon: "plus" }} />
          ) : (
            <>
              <Group
                {...delivery}
                title="EL-2611-00009"
                count={18}
                meta="angekommen 3. Nov. · Post"
                state={<Chip yours>Du bist dran</Chip>}
                actions={[{ label: "Öffnen" }]}
              >
                <Text type="body" weight="strong">
                  10 Artikel sind ausgelaufen.
                </Text>
                <Steps
                  label="Weg der Einlieferung"
                  items={[
                    { label: "Angekommen", meta: "3. Nov.", state: "done" },
                    { label: "Läuft", meta: "10 von 18 ausgelaufen", state: "now" },
                    { label: "Abgerechnet", state: "next" },
                    { label: "Ausgezahlt", state: "next" },
                  ]}
                />
                <List label="Artikel, die zuletzt ausgelaufen sind">
                  <Row
                    mark={category.clock}
                    lines={["Standuhr, Schwarzwald um 1880", "verkauft am 15. Nov."]}
                    time="1.450,00 €"
                    marks={<Chip status="ok">Verkauft</Chip>}
                  />
                  <Row
                    mark={category.silver}
                    lines={["Silberbesteck, 84 Teile", "verkauft am 15. Nov."]}
                    time="2.100,00 €"
                    marks={<Chip status="ok">Verkauft</Chip>}
                  />
                  <Row
                    mark={category.chair}
                    lines={["Biedermeier-Sessel, Paar", "ohne Gebot ausgelaufen"]}
                    time="Schätzung 900 €"
                    marks={<Chip status="warn">Zurück</Chip>}
                  />
                </List>
                <Table
                  label="Abrechnung"
                  rows={settlements}
                  columns={[
                    {
                      title: "Auslauftag",
                      cell: (row) => ({
                        lines: [
                          <Inline>
                            <Mark {...settlement} />
                            <Text>{row.day}</Text>
                          </Inline>,
                          row.items,
                        ],
                      }),
                    },
                    {
                      title: "Abrechnung",
                      cell: (row) => ({
                        lines: [row.when, <Progress value={row.workday} of={22} label={`Arbeitstag ${row.workday} von 22`} />],
                      }),
                    },
                    { title: "Auszahlung", align: "end", cell: (row) => ({ lines: [row.amount, row.estimate ? "geschätzt" : ""] }) },
                  ]}
                />
                <Facts
                  inline
                  items={[
                    { label: "Quittung", value: "Q-2611-00009" },
                    { label: "Vertrag", value: "VT-2610-00031" },
                  ]}
                  end={
                    <Button variant="text" icon="printer">
                      Drucken
                    </Button>
                  }
                />
              </Group>
              <Group
                {...delivery}
                title="EL-2610-00031"
                count={6}
                meta="angekommen 14. Okt."
                state={<Chip status="warn">Wartet auf Abholung</Chip>}
              >
                <Text>2 Artikel sind nicht verkauft und warten auf Abholung bis 12. Dez.</Text>
                <List label="Artikel, die auf Abholung warten">
                  <Row mark={category.painting} lines={["Ölbild „Rheinauen“, signiert", "Halle 1 · Regal B2"]} time="bis 12. Dez." />
                  <Row mark={category.chair} lines={["Nähtisch, Kirsche", "Halle 1 · Regal B4"]} time="bis 12. Dez." />
                </List>
              </Group>
              <Group {...delivery} title="EL-2609-00017" folded state={<Chip status="ok">Ausgezahlt</Chip>} />
            </>
          )}
        </Section>
      </Pane>
    </Workspace>
  );
}

// The states that Fibel's Example offers beside the default; the recipe test renders each one as well.
export const states = {
  empty: () => <CustomerDeliveries empty />,
  loading: () => <CustomerDeliveries loading />,
  failed: () => <CustomerDeliveries failed />,
};
