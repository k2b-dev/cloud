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
  List,
  Loading,
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
import { For } from "solid-js";

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
type Article = {
  mark: { icon: string; color: string };
  name: string;
  meta: string;
  time: string;
  chip?: { status: "ok" | "warn"; label: string };
};

// What the server loaded for this tab. The screen only places it; `worst` at the end is the same shape at its limits.
type Deliveries = {
  name: string;
  color: string;
  ids: { label?: string; icon?: string; value: string; copy?: boolean }[];
  customers: string;
  counts: { deliveries: string; money: string };
  next: { title: string; text: string };
  summary: string;
  open: {
    title: string;
    count: string;
    arrived: string;
    meta: string;
    lead: string;
    running: string;
    articles: Article[];
    settlements: Settlement[];
    receipt: string;
    contract: string;
  };
  waiting: { title: string; count: string; meta: string; text: string; articles: Article[] };
  paid: string;
};

const ottilie: Deliveries = {
  name: "Ottilie Brandner",
  color: "#1d4ed8",
  ids: [{ label: "Kunde", value: "7K4QX" }],
  customers: "412",
  counts: { deliveries: "3", money: "12" },
  next: { title: "Die nächste Abrechnung kommt am 15. Dez.", text: "Geschätzt 180,00 € für 10 Artikel." },
  summary: "18 Artikel laufen, 10 sind ausgelaufen.",
  open: {
    title: "EL-2611-00009",
    count: "18",
    arrived: "3. Nov.",
    meta: "angekommen 3. Nov. · Post",
    lead: "10 Artikel sind ausgelaufen.",
    running: "10 von 18 ausgelaufen",
    articles: [
      {
        mark: category.clock,
        name: "Standuhr, Schwarzwald um 1880",
        meta: "verkauft am 15. Nov.",
        time: "1.450,00 €",
        chip: { status: "ok", label: "Verkauft" },
      },
      {
        mark: category.silver,
        name: "Silberbesteck, 84 Teile",
        meta: "verkauft am 15. Nov.",
        time: "2.100,00 €",
        chip: { status: "ok", label: "Verkauft" },
      },
      {
        mark: category.chair,
        name: "Biedermeier-Sessel, Paar",
        meta: "ohne Gebot ausgelaufen",
        time: "Schätzung 900 €",
        chip: { status: "warn", label: "Zurück" },
      },
    ],
    settlements: [
      { day: "15. Nov.", items: "10 Artikel", when: "15. Dez.", workday: 5, amount: "180,00 €", estimate: true },
      { day: "24. Nov.", items: "8 Artikel", when: "15. Jan.", workday: 0, amount: "offen", estimate: false },
    ],
    receipt: "Q-2611-00009",
    contract: "VT-2610-00031",
  },
  waiting: {
    title: "EL-2610-00031",
    count: "6",
    meta: "angekommen 14. Okt.",
    text: "2 Artikel sind nicht verkauft und warten auf Abholung bis 12. Dez.",
    articles: [
      { mark: category.painting, name: "Ölbild „Rheinauen“, signiert", meta: "Halle 1 · Regal B2", time: "bis 12. Dez." },
      { mark: category.chair, name: "Nähtisch, Kirsche", meta: "Halle 1 · Regal B4", time: "bis 12. Dez." },
    ],
  },
  paid: "EL-2609-00017",
};

// `empty`: a customer without a delivery yet; `loading` and `failed`: the deliveries of this tab.
type Props = { data?: Deliveries; empty?: boolean; loading?: boolean; failed?: boolean };

const ArticleRow = (props: { article: Article }) => (
  <Row
    mark={props.article.mark}
    lines={[props.article.name, props.article.meta]}
    time={props.article.time}
    marks={props.article.chip && <Chip status={props.article.chip.status}>{props.article.chip.label}</Chip>}
  />
);

export default function CustomerDeliveries(props: Props) {
  const ready = !props.empty && !props.loading && !props.failed;
  const data = props.data ?? ottilie;
  return (
    <Workspace
      sidebar={
        <Nav
          title="Kunden"
          icon="users"
          groups={[
            {
              items: [
                { label: "Alle Kunden", icon: "users", current: true, count: data.customers },
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
          start={<RecordHead name={data.name} avatar={{ name: data.name, color: data.color }} ids={data.ids} />}
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
              { label: "Einlieferungen", icon: "package", count: ready ? data.counts.deliveries : undefined, current: true },
              { label: "Geld", icon: "currency-euro", count: ready ? data.counts.money : undefined, href: "#geld" },
            ]}
          />
        }
      >
        {/* One statement that stands out in the column: a band in a tone, not a message with a title and deeds. */}
        {ready && (
          <Band tone="note">
            <Text type="body" weight="strong">
              {data.next.title}
            </Text>
            <Text>{data.next.text}</Text>
          </Band>
        )}
        <Section
          icon="package"
          color="#c2410c"
          title="Einlieferungen"
          count={ready ? data.counts.deliveries : undefined}
          actions={[{ label: "Herausgabe", icon: "package-export" }]}
          summary={ready ? data.summary : undefined}
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
                title={data.open.title}
                count={data.open.count}
                meta={data.open.meta}
                state={<Chip yours>Du bist dran</Chip>}
                actions={[{ label: "Öffnen" }]}
              >
                <Text type="body" weight="strong">
                  {data.open.lead}
                </Text>
                <Steps
                  label="Weg der Einlieferung"
                  items={[
                    { label: "Angekommen", meta: data.open.arrived, state: "done" },
                    { label: "Läuft", meta: data.open.running, state: "now" },
                    { label: "Abgerechnet", state: "next" },
                    { label: "Ausgezahlt", state: "next" },
                  ]}
                />
                <List label="Artikel, die zuletzt ausgelaufen sind">
                  <For each={data.open.articles}>{(article) => <ArticleRow article={article} />}</For>
                </List>
                <Table
                  label="Abrechnung"
                  rows={data.open.settlements}
                  columns={[
                    {
                      title: "Auslauftag",
                      mark: () => settlement,
                      cell: (row) => ({ lines: [row.day, row.items] }),
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
                    { label: "Quittung", value: data.open.receipt },
                    { label: "Vertrag", value: data.open.contract },
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
                title={data.waiting.title}
                count={data.waiting.count}
                meta={data.waiting.meta}
                state={<Chip status="warn">Wartet auf Abholung</Chip>}
              >
                <Text>{data.waiting.text}</Text>
                <List label="Artikel, die auf Abholung warten">
                  <For each={data.waiting.articles}>{(article) => <ArticleRow article={article} />}</For>
                </List>
              </Group>
              <Group {...delivery} title={data.paid} folded state={<Chip status="ok">Ausgezahlt</Chip>} />
            </>
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

// The realistic worst case of the same tab, for Fibel's Example and the recipe test: a long company name, ids that
// cannot wrap, ten-digit amounts, counts above a thousand and exactly one, one letter, right-to-left and Chinese
// script, emoji joined into one sign, and an article whose consignor's account was deleted.
const worst: Deliveries = {
  name: "Nachlassverwaltung Oberhauser-Wettstein & Söhne Antiquitätenhandelsgesellschaft mbH & Co. KG",
  color: "#7c2d12",
  ids: [
    { label: "Kunde", value: "7K4QX-2026-NACHLASS-OBERHAUSER-000001", copy: true },
    { label: "USt-IdNr.", value: "DE 123 456 789" },
  ],
  customers: "12.840",
  counts: { deliveries: "1.284", money: "1" },
  next: {
    title: "Die nächste Abrechnung kommt am 15. Dez., wenn das Nachlassgericht bis dahin freigibt.",
    text: "Geschätzt 1.234.567.890,12 € für 38.412 Artikel; 1 Artikel ist strittig.",
  },
  summary: "53.007 Artikel laufen, 38.412 sind ausgelaufen, 1 wurde zurückgezogen.",
  open: {
    title: "EL-2611-00009-NACHLASS-VILLA-SONNENHALDE",
    count: "53.007",
    arrived: "31. Dez. 2025",
    meta: "angekommen 31. Dez. 2025 · Spedition Kraus & Oberhauser-Wettstein Logistik",
    lead: "38.412 Artikel sind ausgelaufen; 👩‍👩‍👧‍👦 die Familie möchte 1 Stück zurück.",
    running: "38.412 von 53.007 ausgelaufen",
    articles: [
      {
        mark: category.silver,
        name: "Tafelsilber der Familie Oberhauser-Wettstein, vollständiges Service für vierundzwanzig Personen mit Monogramm",
        meta: "verkauft am 15. Nov. an Bieterin 0000012840",
        time: "1.234.567.890,12 €",
        chip: { status: "ok", label: "Verkauft" },
      },
      {
        mark: category.painting,
        name: "青花瓷瓶, 清代",
        meta: "ohne Gebot ausgelaufen",
        time: "Schätzung 12.000 €",
        chip: { status: "warn", label: "Zurück" },
      },
      { mark: category.chair, name: "سجادة فارسية يدوية", meta: "Einlieferer: Gelöschte Person", time: "8.400,00 €" },
      { mark: category.clock, name: "X", meta: "—", time: "0,00 €" },
    ],
    settlements: [
      { day: "31. Dez. 2025", items: "38.412 Artikel", when: "15. Dez.", workday: 21, amount: "1.234.567.890,12 €", estimate: true },
      { day: "1. Jan.", items: "1 Artikel", when: "15. Jan.", workday: 0, amount: "offen", estimate: false },
    ],
    receipt: "Q-2611-00009-NACHLASS-VILLA-SONNENHALDE",
    contract: "VT-2610-00031-SONDERKONDITIONEN-NACHLASS",
  },
  waiting: {
    title: "王秀英的瓷器收藏",
    count: "1",
    meta: "angekommen 14. Okt.",
    text: "1 Artikel ist nicht verkauft und wartet auf Abholung durch ليلى عبد الرحمن bis 12. Dez.",
    articles: [{ mark: category.painting, name: "Ö", meta: "Halle 1 · Regal B2", time: "bis 12. Dez." }],
  },
  paid: "EL-1",
};
