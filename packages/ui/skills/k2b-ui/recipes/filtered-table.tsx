// Recipe: a table people filter, sort and group. The list is declared once with `defineListQuery` (shared with the
// server), the filters stand as statements in a `FilterBar` above the `StatusRow`, the sort and the grouping in words in
// its `filters`. The address holds the whole state: the server reads it with `parse`, filters its own data, and renders
// this page; the bar writes the address and calls `onChange`, and the app loads its rows again.
import {
  Avatar,
  Bar,
  Button,
  Chip,
  FilterBar,
  Inline,
  Input,
  ListOrder,
  Mark,
  Nav,
  Pane,
  StatusRow,
  Table,
  Tabs,
  Text,
  Workspace,
} from "@k2b/ui/v2";
import { defineListQuery, field, type ListQueryStateOf, type LookupItem } from "@k2b/ui/v2/list-query";
import { createSignal } from "solid-js";

const STATUS = [
  { value: "open", label: "Offen" },
  { value: "work", label: "In Arbeit" },
  { value: "done", label: "Erledigt" },
] as const;

const CUSTOMERS: LookupItem[] = [
  { value: "k-204", label: "Familie Oswald", meta: "Freiburg" },
  { value: "k-311", label: "Architekturbüro Winter", meta: "Offenburg" },
  { value: "k-118", label: "Stadtwerke Auental", meta: "Lahr" },
];

// In the app this lives in a module of its own, imported by the server route and the island.
export const orderQuery = defineListQuery({
  key: "orders",
  fields: {
    status: field.choice({ label: "Status", options: STATUS, common: true }),
    amount: field.numberRange({ label: "Betrag", unit: "€", common: true, presets: [{ max: 500 }, { min: 500 }] }),
    customer: field.lookup({
      label: "Kunde",
      common: true,
      // the app's own search, with its own access checks; abort with the signal
      load: async (query, { signal }) => {
        const response = await fetch(`/api/customers?q=${encodeURIComponent(query)}`, { signal });
        return { items: (await response.json()) as LookupItem[] };
      },
      resolve: async (values) => CUSTOMERS.filter((customer) => values.includes(customer.value)),
    }),
  },
  search: { label: "Auftrag oder Kunde" },
  sort: {
    options: { due: { label: "Fällig", directions: ["asc", "desc"] }, amount: { label: "Betrag", directions: ["desc", "asc"] } },
    default: { field: "due", direction: "asc" },
  },
  group: { status: { label: "Status" } },
});

// The app this screen belongs to: its colour tints the page and marks it in the host's rail.
export const app = { color: "#c2410c", icon: "tool" };

// One mark per kind of order, the same in every list, card and sentence of the app.
const kind = {
  kitchen: { icon: "tools-kitchen-2", color: "#c2410c" },
  cabinet: { icon: "door", color: "#7c3aed" },
  repair: { icon: "hammer", color: "#0e7490" },
  shelf: { icon: "books", color: "#15803d" },
};
const people = {
  felix: { name: "Felix Thal" },
  jonas: { name: "Jonas Kern" },
  mira: { name: "Mira Solberg" },
  sami: { name: "Sami Yilmaz" },
};

type Order = {
  number: string;
  title: string;
  kind: keyof typeof kind;
  customer: string;
  status: (typeof STATUS)[number]["value"];
  team: { name: string }[];
  due: string;
  late?: boolean;
  amount: number;
};

// What the server found for the address below (it filtered and sorted with the same declaration).
const orders: Order[] = [
  {
    number: "A-1038",
    title: "Küche Lindqvist",
    kind: "kitchen",
    customer: "Praxis Dr. Lindqvist",
    status: "work",
    team: [people.felix, people.jonas],
    due: "26.11.2026",
    late: true,
    amount: 8640,
  },
  {
    number: "A-1042",
    title: "Einbauschrank Flur",
    kind: "cabinet",
    customer: "Familie Oswald",
    status: "open",
    team: [people.mira],
    due: "28.11.2026",
    amount: 1280,
  },
  {
    number: "A-1044",
    title: "Treppe Winter",
    kind: "repair",
    customer: "Architekturbüro Winter",
    status: "work",
    team: [people.sami, people.felix],
    due: "29.11.2026",
    amount: 2150,
  },
  {
    number: "A-1047",
    title: "Küchenfront Eiche",
    kind: "kitchen",
    customer: "Architekturbüro Winter",
    status: "work",
    team: [people.felix, people.mira, people.jonas],
    due: "02.12.2026",
    amount: 3420,
  },
  {
    number: "A-1049",
    title: "Empfangstresen",
    kind: "cabinet",
    customer: "Hotel Seeblick",
    status: "open",
    team: [people.jonas],
    due: "03.12.2026",
    amount: 5900,
  },
  {
    number: "A-1051",
    title: "Regal Archiv",
    kind: "shelf",
    customer: "Stadtwerke Auental",
    status: "open",
    team: [people.sami],
    due: "05.12.2026",
    amount: 760,
  },
  {
    number: "A-1052",
    title: "Bad Oswald",
    kind: "repair",
    customer: "Familie Oswald",
    status: "work",
    team: [people.mira, people.sami],
    due: "08.12.2026",
    amount: 4310,
  },
  {
    number: "A-1055",
    title: "Weinregal Keller",
    kind: "shelf",
    customer: "Weingut Hartwig",
    status: "open",
    team: [people.felix],
    due: "10.12.2026",
    amount: 2480,
  },
  {
    number: "A-1056",
    title: "Garderobe Praxis",
    kind: "cabinet",
    customer: "Physio Kern",
    status: "open",
    team: [people.jonas, people.mira],
    due: "12.12.2026",
    amount: 1640,
  },
  {
    number: "A-1058",
    title: "Küche Gemeindehaus",
    kind: "kitchen",
    customer: "Gemeinde Ohlsbach",
    status: "open",
    team: [people.felix, people.sami],
    due: "15.12.2026",
    amount: 11200,
  },
];

const tone = { open: "warn", work: "ok", done: "ok" } as const;
const label = (status: Order["status"]) => STATUS.find((option) => option.value === status)?.label ?? status;
const euro = (amount: number) => `${amount.toLocaleString("de-DE")} €`;

type Props = { rows?: Order[]; loading?: boolean; address?: string };

export default function FilteredOrders(props: Props) {
  const rows = () => props.rows ?? orders;
  // the state the server parsed from the address, here `?status=open,work&amount=500..`
  const [state, setState] = createSignal<ListQueryStateOf<typeof orderQuery>>(
    orderQuery.parse(props.address ?? "status=open,work&amount=500..").state,
  );
  return (
    <Workspace
      sidebar={
        <Nav
          title="Werkstatt"
          icon="tool"
          groups={[
            {
              items: [
                { label: "Heute", icon: "sun", href: "#heute" },
                { label: "Aufträge", icon: "clipboard-list", count: 34, current: true },
                { label: "Termine", icon: "calendar", count: 9, href: "#termine" },
                { label: "Material", icon: "package", href: "#material", dot: "warn" },
              ],
            },
            {
              label: "Teams",
              items: [
                { label: "Montage", icon: "truck", color: "#0e7490", href: "#montage" },
                { label: "Schreinerei", icon: "hammer", color: "#c2410c", href: "#schreinerei" },
                { label: "Büro", icon: "briefcase", color: "#7c3aed", href: "#buero" },
              ],
            },
          ]}
        />
      }
      head={
        <Bar
          start={
            <Tabs
              label="Ansichten"
              items={[
                { label: "Alle", count: 34, current: true, href: "?" },
                { label: "Diese Woche", count: 6, href: "?view=week" },
              ]}
            />
          }
          end={
            <>
              <Input type="search" icon="search" label="Auftrag oder Kunde" placeholder="Auftrag oder Kunde" />
              <Button variant="primary" icon="plus">
                Auftrag
              </Button>
            </>
          }
        />
      }
      primary={{ label: "Auftrag", icon: "plus" }}
    >
      <Pane
        label="Aufträge"
        status={
          <>
            <FilterBar
              query={orderQuery}
              state={state()}
              onChange={setState}
              icons={{ status: "circle-dashed", amount: "currency-euro", customer: "user" }}
              names={{ customer: CUSTOMERS }}
              results={`${rows().length} Aufträge`}
            />
            {/* k2b-ui gap: the count and the order belong at the end of the filter row (two head rows, rule 9) */}
            <StatusRow
              lead={props.loading ? "Wird geladen" : `${euro(rows().reduce((sum, order) => sum + order.amount, 0))} in Arbeit und offen`}
              facts={props.loading ? [] : [{ value: rows().length, after: "von 34 Aufträgen" }]}
              filters={<ListOrder query={orderQuery} state={state()} onChange={setState} />}
            />
          </>
        }
      >
        <Table
          label="Aufträge"
          rows={rows()}
          loading={props.loading && { rows: 8 }}
          open={(row) => ({ href: `#${row.number}` })}
          empty={{ icon: "filter-off", text: "Kein Auftrag passt zu diesen Filtern." }}
          phone={(row) => ({
            mark: kind[row.kind],
            lines: [row.title, `${row.number} · ${row.customer} · fällig ${row.due}`],
            time: euro(row.amount),
            marks: row.late ? <Chip status="bad">Verzug</Chip> : undefined,
          })}
          // the widths fit beside the sidebar from 1024 px on; below that the table becomes `phone` rows
          columns={[
            {
              title: "Auftrag",
              width: { min: 170, default: 190 },
              // the order's mark leads its name; `Inline` keeps the one gap between them
              cell: (row) => (
                <Inline>
                  <Mark {...kind[row.kind]} />
                  <Text>{row.title}</Text>
                </Inline>
              ),
            },
            { title: "Kunde", width: { min: 140, default: 160 }, cell: (row) => row.customer, drop: true },
            {
              title: "Status",
              width: { min: 100, default: 110 },
              cell: (row) => (row.late ? <Chip status="bad">Verzug</Chip> : <Chip status={tone[row.status]}>{label(row.status)}</Chip>),
            },
            // the team as faces: one picture with every name
            { title: "Team", width: { min: 80, default: 90 }, drop: true, cell: (row) => <Avatar.Stack people={row.team} /> },
            { title: "Fällig", width: { min: 90, default: 100 }, cell: (row) => row.due, drop: true },
            { title: "Betrag", width: { min: 80, default: 90 }, align: "end", cell: (row) => euro(row.amount) },
          ]}
        />
      </Pane>
    </Workspace>
  );
}

// The states Fibel's Example offers beside the default; the recipe test renders each one as well. `editor` opens the
// editor of the status filter the way a person does, by pressing its statement.
export const states = {
  empty: () => <FilteredOrders rows={[]} address="status=done&amount=5000.." />,
  loading: () => <FilteredOrders loading />,
  editor: { render: () => <FilteredOrders />, press: "Filter Status ist Offen oder In Arbeit bearbeiten" },
};
