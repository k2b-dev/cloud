// Recipe: a table people filter, sort and group. The list is declared once with `defineListQuery` (shared with the
// server), the filters stand as statements in a `FilterBar` above the `StatusRow`, the sort and the grouping in words in
// its `filters`. The address holds the whole state: the server reads it with `parse`, filters its own data, and renders
// this page; the bar writes the address and calls `onChange`, and the app loads its rows again.
import { Bar, Button, Chip, FilterBar, Input, ListOrder, Pane, StatusRow, Table, Tabs, Workspace } from "@k2b/ui/v2";
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

type Order = { number: string; title: string; customer: string; status: (typeof STATUS)[number]["value"]; due: string; amount: number };

// What the server found for the address below (it filtered and sorted with the same declaration).
const orders: Order[] = [
  { number: "A-1042", title: "Einbauschrank Flur", customer: "Familie Oswald", status: "open", due: "28.11.2026", amount: 1280 },
  { number: "A-1047", title: "Küchenfront Eiche", customer: "Architekturbüro Winter", status: "work", due: "02.12.2026", amount: 3420 },
  { number: "A-1051", title: "Regal Archiv", customer: "Stadtwerke Auental", status: "open", due: "05.12.2026", amount: 760 },
];

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
            <StatusRow
              lead={props.loading ? "Wird geladen" : `${rows().length} von 34 Aufträgen`}
              facts={props.loading ? [] : [{ before: "Summe", value: euro(rows().reduce((sum, order) => sum + order.amount, 0)) }]}
              filters={<ListOrder query={orderQuery} state={state()} onChange={setState} />}
            />
          </>
        }
      >
        <Table
          label="Aufträge"
          rows={rows()}
          loading={props.loading && { rows: 3 }}
          open={(row) => ({ href: `#${row.number}` })}
          empty={{ icon: "filter-off", text: "Kein Auftrag passt zu diesen Filtern." }}
          phone={(row) => ({ lines: [row.title, `${row.number} · ${row.customer} · fällig ${row.due}`], time: euro(row.amount) })}
          columns={[
            { title: "Nummer", width: { min: 90, default: 100 }, cell: (row) => row.number, drop: true },
            { title: "Auftrag", width: { min: 160, default: 220 }, cell: (row) => row.title },
            { title: "Kunde", width: { min: 140, default: 200 }, cell: (row) => row.customer, drop: true },
            {
              title: "Status",
              width: { min: 100, default: 120 },
              cell: (row) => <Chip status={row.status === "open" ? "warn" : "ok"}>{label(row.status)}</Chip>,
            },
            { title: "Fällig", width: { min: 90, default: 110 }, cell: (row) => row.due, drop: true },
            { title: "Betrag", width: { min: 90, default: 110 }, align: "end", cell: (row) => euro(row.amount) },
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
