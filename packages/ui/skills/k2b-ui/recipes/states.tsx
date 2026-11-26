// Recipe: the states of a list, each in the place where the rows stand, so the head and the status row never move.
// Nothing yet and nothing behind a filter are two different sentences with their own way out; loading holds the place
// of the rows that will come; data that failed to load once offers "Erneut versuchen" there and nowhere else. A problem
// a person must fix is a Notice that names the deed; a connection that retries on its own says so in the status row.
import { Bar, Button, Chip, Empty, Failed, Loading, Nav, Notice, Pane, StatusRow, Table, Tabs, Workspace } from "@k2b/ui/v2";

// The app this screen belongs to: its colour tints the page and marks it in the host's rail.
export const app = { name: "Lager", color: "#0e7490", icon: "building-warehouse" };

// One mark per kind of goods, the same in every list of the app.
const goods = {
  paint: { icon: "paint", color: "#db2777" },
  wood: { icon: "wood", color: "#a16207" },
  hardware: { icon: "nut", color: "#475569" },
  pallet: { icon: "forklift", color: "#c2410c" },
  tiles: { icon: "layout-grid", color: "#0e7490" },
};

type Delivery = {
  id: string;
  supplier: string;
  goods: keyof typeof goods;
  gate: string;
  amount: string;
  value: string;
  checker?: { name: string };
  time: string;
  state: "ok" | "warn" | "bad";
};
const people = { sami: { name: "Sami Yilmaz" }, jonas: { name: "Jonas Kern" }, mira: { name: "Mira Solberg" } };

const deliveries: Delivery[] = [
  {
    id: "WE-2611-081",
    supplier: "Lackfabrik Nordhaus",
    goods: "paint",
    gate: "Tor 1",
    amount: "6 Gebinde",
    value: "1.284,00 €",
    checker: people.sami,
    time: "07:50",
    state: "ok",
  },
  {
    id: "WE-2611-082",
    supplier: "Holzwerk Brandt",
    goods: "wood",
    gate: "Tor 2",
    amount: "14 Platten",
    value: "3.920,00 €",
    time: "09:40",
    state: "warn",
  },
  {
    id: "WE-2611-083",
    supplier: "Beschläge Krüger",
    goods: "hardware",
    gate: "Tor 1",
    amount: "3 Pakete",
    value: "412,50 €",
    checker: people.jonas,
    time: "10:15",
    state: "ok",
  },
  {
    id: "WE-2611-084",
    supplier: "Spedition Kraus",
    goods: "pallet",
    gate: "Tor 2",
    amount: "1 Palette",
    value: "2.610,00 €",
    checker: people.mira,
    time: "11:05",
    state: "bad",
  },
  {
    id: "WE-2611-085",
    supplier: "Fliesen Ortenau",
    goods: "tiles",
    gate: "Tor 2",
    amount: "22 Kartons",
    value: "1.870,40 €",
    checker: people.mira,
    time: "11:30",
    state: "ok",
  },
  {
    id: "WE-2611-086",
    supplier: "Holzwerk Brandt",
    goods: "wood",
    gate: "Tor 2",
    amount: "40 Leisten",
    value: "640,00 €",
    checker: people.sami,
    time: "12:10",
    state: "ok",
  },
  {
    id: "WE-2611-087",
    supplier: "Beschläge Krüger",
    goods: "hardware",
    gate: "Tor 1",
    amount: "1 Paket",
    value: "96,80 €",
    time: "13:05",
    state: "warn",
  },
  {
    id: "WE-2611-088",
    supplier: "Lackfabrik Nordhaus",
    goods: "paint",
    gate: "Tor 1",
    amount: "2 Gebinde",
    value: "428,00 €",
    checker: people.jonas,
    time: "13:40",
    state: "ok",
  },
  {
    id: "WE-2611-089",
    supplier: "Spedition Kraus",
    goods: "pallet",
    gate: "Tor 2",
    amount: "3 Paletten",
    value: "5.140,00 €",
    checker: people.sami,
    time: "14:20",
    state: "ok",
  },
];
const stateLabel = { ok: "Geprüft", warn: "Wartet", bad: "Beschädigt" } as const;

type Props = {
  rows?: Delivery[];
  loading?: boolean;
  failed?: boolean;
  /** Only Tor 2 is shown: an empty list then says that the filter found nothing, not that nothing came. */
  filtered?: boolean;
  /** The scale at gate 2 does not answer: something a person must fix, while the list stays. */
  problem?: boolean;
  /** The live connection dropped and retries on its own. */
  reconnecting?: boolean;
};

export default function IncomingGoods(props: Props) {
  const rows = () => (props.rows ?? deliveries).filter((row) => !props.filtered || row.gate === "Tor 2");
  return (
    <Workspace
      sidebar={
        <Nav
          title="Lager"
          icon="building-warehouse"
          groups={[
            {
              items: [
                { label: "Wareneingang", icon: "truck-delivery", current: true, count: 9 },
                { label: "Bestand", icon: "packages", href: "#bestand", dot: "warn" },
                { label: "Inventur", icon: "list-check", href: "#inventur" },
              ],
            },
            {
              label: "Orte",
              items: [
                { label: "Halle 1", icon: "building-warehouse", color: "#0e7490", href: "#halle-1" },
                { label: "Halle 2", icon: "building-warehouse", color: "#7c3aed", href: "#halle-2" },
                { label: "Hof", icon: "trees", color: "#15803d", href: "#hof" },
              ],
            },
          ]}
        />
      }
      primary={{ label: "Einlieferung erfassen", icon: "plus", href: "#neu" }}
      head={
        <Bar
          start={
            <Tabs
              label="Zeitraum"
              items={[
                { label: "Heute", current: true, href: "#heute" },
                { label: "Diese Woche", href: "#woche" },
              ]}
            />
          }
          end={
            <Button variant="primary" icon="plus" href="#neu">
              Einlieferung erfassen
            </Button>
          }
        />
      }
    >
      <Pane
        label="Wareneingang"
        status={
          <StatusRow
            lead={props.loading || props.failed ? "Heute" : `${rows().length} angekommen`}
            facts={
              props.reconnecting
                ? [{ value: "Verbindung unterbrochen", after: "· verbindet neu …" }]
                : props.loading || props.failed || rows().length === 0
                  ? []
                  : [{ value: rows().filter((row) => row.state === "bad").length, after: "beschädigt" }]
            }
            filters={
              props.filtered ? (
                <Chip icon="filter" pressed href="#heute">
                  Nur Tor 2
                </Chip>
              ) : (
                <Button variant="ghost" icon="filter" menu>
                  Alle Tore
                </Button>
              )
            }
          />
        }
      >
        {props.problem && (
          <Notice
            tone="bad"
            title="Waage an Tor 2 antwortet nicht"
            actions={[{ label: "Schlüssel prüfen", forward: true, href: "#waage" }]}
          >
            Seit 10:20 kommen keine Gewichte an. Einlieferungen an Tor 2 brauchen bis dahin ein Gewicht von Hand.
          </Notice>
        )}
        {props.failed ? (
          <Failed
            text="Die Einlieferungen von heute konnten nicht geladen werden. Erfasste Einlieferungen bleiben gespeichert."
            onRetry={() => location.reload()}
          />
        ) : props.loading ? (
          <Loading rows={8} lines={2} />
        ) : rows().length === 0 ? (
          props.filtered ? (
            <Empty icon="filter-off" text="Keine Einlieferung an Tor 2." action={{ label: "Filter zurücksetzen", href: "#heute" }} />
          ) : (
            <Empty
              icon="truck"
              text="Heute ist noch nichts angekommen."
              action={{ label: "Einlieferung erfassen", icon: "plus", href: "#neu" }}
            />
          )
        ) : (
          // one line per delivery: what came, through which gate, how much, who checked it and its state
          <Table
            label="Einlieferungen von heute"
            rows={rows()}
            open={(row) => ({ href: `#${row.id}` })}
            phone={(row) => ({
              mark: goods[row.goods],
              lines: [row.supplier, `${row.gate} · ${row.amount} · ${row.value}`],
              time: row.time,
              marks: row.state === "ok" ? undefined : <Chip status={row.state}>{stateLabel[row.state]}</Chip>,
            })}
            columns={[
              { title: "Lieferant", width: { min: 145, default: 220 }, mark: (row) => goods[row.goods], cell: (row) => row.supplier },
              { title: "Tor", width: { min: 56, default: 90 }, cell: (row) => row.gate },
              { title: "Menge", width: { min: 80, default: 130 }, drop: true, cell: (row) => row.amount },
              { title: "Wert", width: { min: 90, default: 140 }, align: "end", cell: (row) => row.value },
              {
                title: "Geprüft von",
                width: { min: 110, default: 170 },
                drop: true,
                avatar: (row) => row.checker ?? { name: "–" },
                cell: (row) => row.checker?.name ?? "noch offen",
              },
              {
                title: "Zustand",
                width: { min: 110, default: 170 },
                cell: (row) => <Chip status={row.state}>{stateLabel[row.state]}</Chip>,
              },
              { title: "Zeit", width: { min: 52, default: 80 }, align: "end", cell: (row) => row.time },
            ]}
          />
        )}
      </Pane>
    </Workspace>
  );
}

// The states that Fibel's Example offers beside the default; the recipe test renders each one as well.
export const states = {
  empty: () => <IncomingGoods rows={[]} />,
  filtered: () => <IncomingGoods rows={deliveries.filter((row) => row.gate === "Tor 1")} filtered />,
  loading: () => <IncomingGoods loading />,
  failed: () => <IncomingGoods failed />,
  problem: () => <IncomingGoods problem />,
  reconnecting: () => <IncomingGoods reconnecting />,
};
