// Recipe: a record tab with groups. A Band in a tone carries the one statement of the tab; one Section for the area;
// one Group per thing that belongs together (here a delivery). A finished one is folded to its head. Inside a group: a
// sentence, its way, a table, facts; no lines, no nesting.
import {
  Band,
  Bar,
  Button,
  Chip,
  Empty,
  Facts,
  Failed,
  Group,
  Loading,
  Pane,
  Progress,
  RecordHead,
  Section,
  Steps,
  Table,
  Tabs,
  Text,
  Workspace,
} from "@k2b/ui/v2";
import { For, Show } from "solid-js";

type Settlement = { day: string; items: string; when: string; workday: number; amount: string; estimate: boolean };

type Delivery = {
  number: string;
  count?: number;
  meta?: string;
  state: { label: string; status?: "ok" | "warn"; yours?: boolean };
  /** An open delivery shows its way, its settlements and its papers; without them it is folded or a sentence. */
  open?: {
    lead: string;
    steps: { label: string; meta?: string; state: "done" | "now" | "next" }[];
    settlements: Settlement[];
    receipt: string;
    contract: string;
  };
  text?: string;
};

// What the server loaded for this tab. The screen only places it; `worst` at the end is the same shape at its limits.
type Deliveries = {
  name: string;
  id: string;
  band: { title: string; text: string };
  summary: string;
  items: Delivery[];
};

const ottilie: Deliveries = {
  name: "Ottilie Brandner",
  id: "7K4QX",
  band: { title: "Die nächste Abrechnung kommt am 15. Dez.", text: "Geschätzt 180,00 € für 10 Artikel." },
  summary: "18 Artikel laufen, 10 sind ausgelaufen.",
  items: [
    {
      number: "EL-2611-00009",
      count: 18,
      meta: "angekommen 3. Nov. · Post",
      state: { label: "Du bist dran", yours: true },
      open: {
        lead: "10 Artikel sind ausgelaufen.",
        steps: [
          { label: "Angekommen", meta: "3. Nov.", state: "done" },
          { label: "Läuft", meta: "10 von 18 ausgelaufen", state: "now" },
          { label: "Abgerechnet", state: "next" },
          { label: "Ausgezahlt", state: "next" },
        ],
        settlements: [
          { day: "15. Nov.", items: "10 Artikel", when: "15. Dez.", workday: 5, amount: "180,00 €", estimate: true },
          { day: "24. Nov.", items: "8 Artikel", when: "15. Jan.", workday: 0, amount: "offen", estimate: false },
        ],
        receipt: "Q-2611-00009",
        contract: "VT-2610-00031",
      },
    },
    {
      number: "EL-2610-00031",
      count: 6,
      meta: "angekommen 14. Okt.",
      state: { label: "Wartet auf Abholung", status: "warn" },
      text: "2 Artikel sind nicht verkauft und warten auf Abholung bis 12. Dez.",
    },
    { number: "EL-2609-00017", state: { label: "Ausgezahlt", status: "ok" } },
  ],
};

// `empty`: a customer without a delivery yet; `loading` and `failed`: the deliveries of this tab.
type Props = { data?: Deliveries; empty?: boolean; loading?: boolean; failed?: boolean };

export default function CustomerDeliveries(props: Props) {
  const d = () => props.data ?? ottilie;
  const ready = () => !props.empty && !props.loading && !props.failed;
  const chip = (state: Delivery["state"]) =>
    state.yours ? (
      <Chip yours>{state.label}</Chip>
    ) : state.status ? (
      <Chip status={state.status}>{state.label}</Chip>
    ) : (
      <Chip>{state.label}</Chip>
    );
  return (
    <Workspace
      head={
        <Bar
          start={<RecordHead name={d().name} avatar={{ name: d().name, color: "#1d4ed8" }} ids={[{ label: "Kunde", value: d().id }]} />}
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
              { label: "Einlieferungen", icon: "package", count: ready() ? d().items.length : undefined, current: true },
            ]}
          />
        }
      >
        {/* One statement that stands out in the column: a band in a tone, not a message with a title and deeds. */}
        {ready() && (
          <Band tone="note">
            <Text type="body" weight="strong">
              {d().band.title}
            </Text>
            <Text>{d().band.text}</Text>
          </Band>
        )}
        <Section
          icon="package"
          color="#c2410c"
          title="Einlieferungen"
          count={ready() ? d().items.length : undefined}
          actions={[{ label: "Herausgabe", icon: "package-export" }]}
          summary={ready() ? d().summary : undefined}
        >
          {props.failed ? (
            <Failed text="Die Einlieferungen konnten nicht geladen werden. Die Akte bleibt offen." onRetry={() => location.reload()} />
          ) : props.loading ? (
            <Loading rows={3} lines={2} />
          ) : props.empty ? (
            <Empty icon="package" text="Noch keine Einlieferung." action={{ label: "Einlieferung erfassen", icon: "plus" }} />
          ) : (
            <For each={d().items}>
              {(delivery) => (
                <Show
                  when={delivery.open}
                  fallback={
                    <Group
                      icon="package"
                      title={delivery.number}
                      count={delivery.count}
                      meta={delivery.meta}
                      folded={!delivery.text}
                      state={chip(delivery.state)}
                    >
                      {delivery.text && <Text>{delivery.text}</Text>}
                    </Group>
                  }
                >
                  {(open) => (
                    <Group
                      icon="package"
                      title={delivery.number}
                      count={delivery.count}
                      meta={delivery.meta}
                      state={chip(delivery.state)}
                      actions={[{ label: "Öffnen" }]}
                    >
                      <Text type="body" weight="strong">
                        {open().lead}
                      </Text>
                      <Steps label="Weg der Einlieferung" items={open().steps} />
                      <Table
                        label="Abrechnung"
                        rows={open().settlements}
                        columns={[
                          { title: "Auslauftag", cell: (row) => ({ lines: [row.day, row.items] }) },
                          {
                            title: "Abrechnung",
                            cell: (row) => ({
                              lines: [row.when, <Progress value={row.workday} of={22} label={`Arbeitstag ${row.workday} von 22`} />],
                            }),
                          },
                          {
                            title: "Auszahlung",
                            align: "end",
                            cell: (row) => ({ lines: [row.amount, row.estimate ? "geschätzt" : ""] }),
                          },
                        ]}
                      />
                      <Facts
                        inline
                        items={[
                          { label: "Quittung", value: open().receipt },
                          { label: "Vertrag", value: open().contract },
                        ]}
                        end={
                          <Button variant="text" icon="printer">
                            Drucken
                          </Button>
                        }
                      />
                    </Group>
                  )}
                </Show>
              )}
            </For>
          )}
        </Section>
      </Pane>
    </Workspace>
  );
}

// The states that Fibel's Example offers beside the default; the recipe test renders each one as well.
export const states = {
  worst: () => <CustomerDeliveries data={worst} />,
  empty: () => <CustomerDeliveries empty />,
  loading: () => <CustomerDeliveries loading />,
  failed: () => <CustomerDeliveries failed />,
};

// The realistic worst case of the same tab, for Fibel's Example and the recipe test: a long company name, counts above
// a thousand and exactly one, long state words, a way with long steps, a settlement in the millions, and twelve
// deliveries of which most are folded.
const worst: Deliveries = {
  name: "Nachlassverwaltung Oberhauser-Wettstein & Söhne Antiquitäten GmbH & Co. KG",
  id: "7K4QX",
  band: {
    title: "Die nächste Abrechnung kommt am 15. Dez., sobald das Nachlassgericht die Freigabe erteilt hat.",
    text: "Geschätzt 12.345.678,90 € für 1.284 Artikel aus 12 Einlieferungen; 1 Artikel ist zurückgezogen.",
  },
  summary: "38.412 Artikel laufen, 1 ist ausgelaufen, 14.595 warten auf die Freigabe durch das Nachlassgericht.",
  items: [
    {
      number: "EL-2611-00009",
      count: 1284,
      meta: "angekommen 31. Dez. 2025, 23:59 · Spedition Oberhauser-Wettstein Logistik · 3 Paletten, 1 Kiste",
      state: { label: "Wartet auf Freigabe durch das Nachlassgericht", yours: true },
      open: {
        lead: "1 Artikel ist ausgelaufen, 1.283 laufen noch, davon 0 mit Gebot.",
        steps: [
          { label: "Angekommen", meta: "31. Dez. 2025", state: "done" },
          { label: "Fotografiert und beschrieben", meta: "1.283 von 1.284", state: "done" },
          { label: "Wartet auf Freigabe durch das Nachlassgericht", meta: "seit 12 Tagen", state: "now" },
          { label: "Abgerechnet", state: "next" },
          { label: "Ausgezahlt an die Erbengemeinschaft", state: "next" },
        ],
        settlements: [
          { day: "15. Nov.", items: "1.284 Artikel", when: "15. Dez.", workday: 22, amount: "12.345.678,90 €", estimate: true },
          { day: "1. Jan.", items: "1 Artikel", when: "31. Dez. 2027", workday: 0, amount: "−42,50 €", estimate: false },
          { day: "24. Nov.", items: "0 Artikel", when: "—", workday: 23, amount: "0,00 €", estimate: false },
        ],
        receipt: "Q-2611-00009-NACHLASS-VILLA-SONNENHALDE",
        contract: "VT-2610-00031 · Sonderkonditionen Nachlass mit Mindestpreis",
      },
    },
    {
      number: "EL-2610-00031",
      count: 1,
      meta: "angekommen 14. Okt. · abgegeben von J",
      state: { label: "Wartet auf Abholung seit 12 Tagen", status: "warn" },
      text: "1 Artikel ist nicht verkauft und wartet auf Abholung bis 12. Dez.; Ansprechpartnerin ist Frau Đặng Thị Ngọc Hân, erreichbar unter bartholomew.fitzgerald@northwind-industries-holdings.example.com.",
    },
    ...Array.from({ length: 10 }, (_, index) => ({
      number: `EL-26${String(9 - (index % 9)).padStart(2, "0")}-${String(17 + index).padStart(5, "0")}`,
      state: {
        label: index % 3 === 0 ? "Ausgezahlt" : index % 3 === 1 ? "Abgerechnet, Auszahlung gesperrt" : "Zurückgegeben",
        status: "ok" as const,
      },
    })),
  ],
};
