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
    // the statement writes amounts as the table does ("ab 500,00 €"); the editor shows "€" beside its fields
    amount: field.numberRange({
      label: "Betrag",
      unit: "€",
      format: { style: "currency", currency: "EUR" },
      common: true,
      presets: [{ max: 500 }, { min: 500 }],
    }),
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
// amounts with cents and a real minus sign; a sum of floats is rounded to the cent by the format
const money = new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR" });
const euro = (amount: number) => money.format(amount).replace("-", "\u2212");
// "1 Auftrag", "5 Aufträge": the plural rule of the locale picks the word
const plural = new Intl.PluralRules("de-DE");
const countOrders = (count: number) => `${count.toLocaleString("de-DE")} ${plural.select(count) === "one" ? "Auftrag" : "Aufträge"}`;

type Props = { rows?: Order[]; loading?: boolean; address?: string; customers?: LookupItem[] };

export default function FilteredOrders(props: Props) {
  const rows = () => props.rows ?? orders;
  // the state the server parsed from the address, here `?status=open,work&amount=500..`
  const [state, setState] = createSignal<ListQueryStateOf<typeof orderQuery>>(
    orderQuery.parse(props.address ?? "status=open,work&amount=500..").state,
  );
  // Grouped, the server orders the rows by their group first, so the rows of a group follow one another; the sample
  // rows here are ordered the same way.
  const shown = () =>
    state().group === "status"
      ? [...rows()].sort((a, b) => STATUS.findIndex((s) => s.value === a.status) - STATUS.findIndex((s) => s.value === b.status))
      : rows();
  // The search is part of the address too: the field shows it, and Enter sets it through the declaration (a search
  // the address holds but no field shows would filter the list for no visible reason).
  const search = (text: string) => {
    const next = orderQuery.set(state(), "q", text.trim());
    if (next) setState(next);
  };
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
              <Input
                type="search"
                icon="search"
                label="Auftrag oder Kunde"
                placeholder="Auftrag oder Kunde"
                value={state().search ?? ""}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.isComposing && event.currentTarget instanceof HTMLInputElement)
                    search(event.currentTarget.value);
                }}
              />
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
              names={{ customer: props.customers ?? CUSTOMERS }}
              results={countOrders(rows().length)}
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
          rows={shown()}
          rowKey={(row) => row.number}
          // the grouping the address chose: rows of one status follow one another under its chip
          group={
            state().group === "status"
              ? (row) => ({
                  key: row.status,
                  head: () => <Chip status={row.status === "open" ? "warn" : "ok"}>{label(row.status)}</Chip>,
                  count: countOrders(shown().filter((other) => other.status === row.status).length),
                })
              : undefined
          }
          loading={props.loading && { rows: 3 }}
          open={(row) => ({ href: `#${row.number}` })}
          empty={{ icon: "filter-off", text: "Kein Auftrag passt zu diesen Filtern." }}
          phone={(row) => ({ lines: [row.title, `${row.number} · ${row.customer} · fällig ${row.due}`], time: euro(row.amount) })}
          columns={[
            { title: "Nummer", width: { min: 90, default: 100 }, cell: (row) => row.number, drop: true, truncate: "middle" },
            { title: "Auftrag", width: { min: 160, default: 220 }, cell: (row) => row.title },
            { title: "Kunde", width: { min: 140, default: 200 }, cell: (row) => row.customer, drop: true },
            {
              title: "Status",
              width: { min: 100, default: 120 },
              cell: (row) => <Chip status={row.status === "open" ? "warn" : "ok"}>{label(row.status)}</Chip>,
            },
            { title: "Fällig", width: { min: 90, default: 110 }, numeric: true, cell: (row) => row.due, drop: true },
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
  worst: () => <FilteredOrders rows={worstOrders} address={worstAddress} customers={worstCustomers} />,
  one: () => <FilteredOrders rows={[orders[0]!]} address="status=open&customer=k-204" />,
  huge: () => <FilteredOrders rows={hugeOrders} address="" />,
};

// The realistic worst case for Fibel's Example and the recipe test: every filter set, a lookup with long names and more
// values than a statement shows, a long search, titles and customers at the length people write them, amounts in the
// millions and with cents. `one` is a single match; `huge` is a long unpaginated list.
const worstCustomers: LookupItem[] = [
  { value: "k-901", label: "Nachlassverwaltung Oberhauser-Wettstein & Söhne Antiquitäten GmbH & Co. KG", meta: "Offenburg" },
  { value: "k-902", label: "Aleksandra Wiśniewska-Kowalczyk", meta: "bartholomew.fitzgerald@northwind-industries-holdings.example.com" },
  { value: "k-903", label: "Jo" },
  { value: "k-904", label: "王秀英" },
  { value: "k-905", label: "Đặng Thị Ngọc Hân" },
];
const worstAddress =
  "status=open,work,done&amount=0.01..12345678.9&customer=k-901,k-902,k-903,k-904,k-905&q=Einbauschrank+Flur+Dachgeschoss+links+neben+der+Treppe&sort=amount.desc&group=status";
const worstOrders: Order[] = [
  {
    number: "A-1042-NACHLASS-SONNENHALDE",
    title: "Einbauschrank Flur Dachgeschoss links neben der Treppe, Eiche massiv, mit Schiebetüren",
    customer: "Nachlassverwaltung Oberhauser-Wettstein & Söhne Antiquitäten GmbH & Co. KG",
    status: "open",
    due: "31.12.2026",
    amount: 12345678.9,
  },
  { number: "A-1", title: "J", customer: "Jo", status: "work", due: "01.01.2027", amount: 0.1 + 0.2 },
  {
    number: "A-1051",
    title: "Benachrichtigungseinstellungen",
    customer: "bartholomew.fitzgerald@northwind-industries-holdings.example.com",
    status: "done",
    due: "05.12.2026",
    amount: -42.5,
  },
  {
    number: "A-1052",
    title: "<script>alert(1)</script> &amp; **fett**",
    customer: "王秀英",
    status: "open",
    due: "06.12.2026",
    amount: 1284,
  },
  { number: "A-1053", title: "Regal Archiv", customer: "Đặng Thị Ngọc Hân", status: "work", due: "07.12.2026", amount: 1000000 },
];
const hugeOrders: Order[] = Array.from({ length: 1000 }, (_, index) => ({
  number: `A-${10000 + index}`,
  title: `Auftrag ${index + 1} · ${orders[index % 3]!.title}`,
  customer: orders[index % 3]!.customer,
  status: STATUS[index % 3]!.value,
  due: "05.12.2026",
  amount: 100 + index,
}));
