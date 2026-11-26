import { createMemo, createSignal } from "solid-js";
import { isServer } from "solid-js/web";
import { Bar, Button, Chip, FilterBar, Input, ListOrder, Pane, StatusRow, Table, Tabs, Workspace } from "../src/v2";
import { defineListQuery, field, type ListQueryStateOf, type LookupItem } from "../src/v2/list-query";

// The inventory of an antiques trade on invented data, as a table with many columns would declare it: thirteen fields
// in categories, most with verbs (contains, is not, before, after, is empty), one without. The query names its own
// parameters (`suche`, `ordnung`, `gruppe`), so the page keeps `sort` and `q` for itself, as a grid with its own table
// sort does. The page filters in the browser only because it is a fixture; a real app filters on its server.

type Item = {
  nr: string;
  title: string;
  status: string;
  era?: string;
  location: string;
  consignor?: string;
  origin?: string;
  received: string;
  due?: string;
  price: number;
  estimate?: number;
  photographed: boolean;
};

const STATUS = [
  { value: "consigned", label: "Eingeliefert" },
  { value: "photographed", label: "Fotografiert" },
  { value: "online", label: "Online" },
  { value: "sold", label: "Verkauft" },
] as const;
const ERAS = [
  { value: "baroque", label: "Barock" },
  { value: "biedermeier", label: "Biedermeier" },
  { value: "art-nouveau", label: "Jugendstil" },
  { value: "art-deco", label: "Art déco" },
] as const;
const LOCATIONS = [
  { value: "hall-a", label: "Halle A" },
  { value: "hall-b", label: "Halle B" },
  { value: "shop", label: "Laden" },
] as const;
const CONSIGNORS: readonly LookupItem[] = [
  { value: "c-1001", label: "Haus Bergmann", meta: "Freiburg" },
  { value: "c-1004", label: "Antik Weber KG", meta: "Kehl" },
  { value: "c-1005", label: "Nachlass Kessler", meta: "Waldkirch" },
];

const items: Item[] = [
  {
    nr: "A-26-0447",
    title: "Jugendstil-Vitrine",
    status: "photographed",
    era: "art-nouveau",
    location: "shop",
    consignor: "c-1001",
    origin: "Wien",
    received: "2026-11-22",
    due: "2026-12-15",
    price: 1720,
    estimate: 1500,
    photographed: true,
  },
  {
    nr: "A-26-0489",
    title: "Kaminuhr, Bronze vergoldet",
    status: "consigned",
    era: "biedermeier",
    location: "hall-b",
    consignor: "c-1004",
    received: "2026-10-20",
    price: 1800,
    photographed: false,
  },
  {
    nr: "A-26-0608",
    title: "Spiegel mit Goldrahmen",
    status: "online",
    era: "baroque",
    location: "hall-a",
    consignor: "c-1004",
    origin: "Augsburg",
    received: "2026-10-24",
    due: "2026-11-30",
    price: 1970,
    estimate: 2400,
    photographed: true,
  },
  {
    nr: "A-26-0612",
    title: "Vitrinenschrank, Nussbaum",
    status: "consigned",
    location: "hall-a",
    received: "2026-11-10",
    price: 640,
    photographed: false,
  },
  {
    nr: "A-26-0643",
    title: "Sammeltasse mit Untertasse",
    status: "sold",
    era: "biedermeier",
    location: "shop",
    consignor: "c-1005",
    origin: "Meißen",
    received: "2026-10-20",
    price: 270,
    estimate: 300,
    photographed: true,
  },
  {
    nr: "A-26-0671",
    title: "Tischlampe, Messing",
    status: "photographed",
    era: "art-deco",
    location: "hall-b",
    consignor: "c-1001",
    received: "2026-09-24",
    due: "2027-01-08",
    price: 480,
    photographed: true,
  },
];

export const inventoryQuery = defineListQuery({
  key: "inventory",
  fields: {
    status: field.choice({ label: "Status", options: STATUS, common: true, verbs: ["is", "not"] }),
    title: field.text({
      label: "Titel",
      common: true,
      verbs: ["contains", "is", "notContains", "startsWith", "empty", "notEmpty"],
    }),
    price: field.numberRange({
      label: "Preis",
      unit: "€",
      common: true,
      presets: [{ max: 500 }, { min: 500, max: 2000 }, { min: 2000 }],
      verbs: ["between", "after", "before", "is", "empty"],
    }),
    estimate: field.numberRange({
      label: "Schätzwert",
      unit: "€",
      category: "Preise",
      verbs: ["between", "after", "before", "empty", "notEmpty"],
    }),
    received: field.dateRange({
      label: "Eingang",
      category: "Termine",
      presets: [{ value: "last-7d", label: "letzte 7 Tage" }],
      verbs: ["between", "is", "before", "after"],
    }),
    due: field.dateRange({ label: "Fällig", category: "Termine", verbs: ["before", "after", "between", "empty", "notEmpty"] }),
    seen: field.timeRange({
      label: "Zuletzt gesehen",
      category: "Termine",
      presets: [{ value: "last-1h", label: "letzte Stunde" }],
      verbs: ["between", "before", "after"],
    }),
    consignor: field.lookup({
      label: "Einlieferer",
      category: "Herkunft",
      load: async (query) => ({ items: CONSIGNORS.filter((item) => item.label.toLowerCase().includes(query.toLowerCase())) }),
      resolve: async (values) => CONSIGNORS.filter((item) => values.includes(item.value)),
      verbs: ["is", "not", "empty", "notEmpty"],
    }),
    origin: field.text({ label: "Herkunftsort", category: "Herkunft", verbs: ["contains", "is", "empty", "notEmpty"] }),
    era: field.choice({ label: "Epoche", options: ERAS, category: "Herkunft", verbs: ["is", "not", "empty", "notEmpty"] }),
    location: field.choice({ label: "Lagerort", options: LOCATIONS, category: "Lager", verbs: ["is", "not"] }),
    // a field without verbs keeps its plain value and sentence
    shelf: field.text({ label: "Regal", category: "Lager" }),
    photographed: field.bool({ label: "Fotografiert", labels: { yes: "ja", no: "nein" }, category: "Lager" }),
  },
  search: { label: "Nummer oder Titel" },
  sort: {
    options: {
      price: { label: "Preis", kind: "number", directions: ["desc", "asc"] },
      received: { label: "Eingang", kind: "date", directions: ["desc", "asc"] },
    },
    default: { field: "received", direction: "desc" },
  },
  group: { status: { label: "Status" }, location: { label: "Lagerort" } },
  // the page's table keeps `sort` and `q` for its own column sort and quick search
  params: { search: "suche", sort: "ordnung", group: "gruppe" },
  pageParams: ["sort", "q"],
});

type State = ListQueryStateOf<typeof inventoryQuery>;
type Filters = State["filters"];

const label = (options: readonly { value: string; label: string }[], code: string | undefined) =>
  options.find((o) => o.value === code)?.label ?? code ?? "";

/** How a fixture reads one verb: what a real app does on its server with the same state. */
const text = (term: Filters["title"], value: string | undefined): boolean => {
  if (!term) return true;
  const words = (value ?? "").toLowerCase();
  switch (term.verb) {
    case "empty":
      return !value;
    case "notEmpty":
      return !!value;
    case "is":
      return words === term.value.toLowerCase();
    case "contains":
      return words.includes(term.value.toLowerCase());
    case "notContains":
      return !words.includes(term.value.toLowerCase());
    case "startsWith":
      return words.startsWith(term.value.toLowerCase());
  }
};
const choice = (term: { verb: string; value?: readonly string[] } | undefined, value: string | undefined): boolean => {
  if (!term) return true;
  if (term.verb === "empty") return value === undefined;
  if (term.verb === "notEmpty") return value !== undefined;
  const hit = value !== undefined && (term.value ?? []).includes(value);
  return term.verb === "not" ? !hit : hit;
};
const amount = (term: Filters["estimate"] | Filters["price"], value: number | undefined): boolean => {
  if (!term) return true;
  if (term.verb === "empty") return value === undefined;
  if (term.verb === "notEmpty") return value !== undefined;
  if (value === undefined) return false;
  if (term.verb === "between") return (term.value.min ?? -Infinity) <= value && value <= (term.value.max ?? Infinity);
  if (term.verb === "after") return value > term.value;
  if (term.verb === "before") return value < term.value;
  return value === term.value;
};
const day = (term: Filters["due"] | Filters["received"], value: string | undefined): boolean => {
  if (!term) return true;
  if (term.verb === "empty") return value === undefined;
  if (term.verb === "notEmpty") return value !== undefined;
  if (value === undefined) return false;
  if (term.verb === "before") return value < term.value;
  if (term.verb === "after") return value > term.value;
  if (term.verb === "is") return value === term.value;
  const period = term.value;
  return period.kind === "preset" || ((period.from ?? "") <= value && value <= (period.to ?? "9999"));
};

const matches = (item: Item, state: State) => {
  const f = state.filters;
  return (
    choice(f.status, item.status) &&
    text(f.title, item.title) &&
    amount(f.price, item.price) &&
    amount(f.estimate, item.estimate) &&
    day(f.received, item.received) &&
    day(f.due, item.due) &&
    choice(f.consignor, item.consignor) &&
    text(f.origin, item.origin) &&
    choice(f.era, item.era) &&
    choice(f.location, item.location) &&
    (f.shelf === undefined || item.location.includes(f.shelf)) &&
    (f.photographed === undefined || f.photographed === item.photographed)
  );
};

declare global {
  interface Window {
    /** The address of every change, in order. */
    __verbChanges?: string[];
  }
}

export function Demo() {
  const initial = inventoryQuery.parse(isServer ? "" : location.search).state;
  const [state, setState] = createSignal<State>(initial);
  const rows = createMemo(() => {
    const list = items.filter((item) => matches(item, state()));
    const sort = state().sort;
    const sign = sort.direction === "asc" ? 1 : -1;
    list.sort((a, b) => (sort.field === "price" ? (a.price - b.price) * sign : a.received.localeCompare(b.received) * sign));
    return list;
  });
  const change = (next: State) => {
    if (!isServer) window.__verbChanges = [...(window.__verbChanges ?? []), location.search];
    setState(next);
  };
  return (
    <Workspace
      head={
        <Bar
          start={
            <Tabs
              label="Ansichten"
              items={[
                { label: "Inventar", count: items.length, href: "?", current: true },
                { label: "Fällig", href: "?due.notEmpty=" },
              ]}
            />
          }
          end={
            <>
              <Input type="search" icon="search" label="Nummer oder Titel" placeholder="Nummer oder Titel" />
              <Button variant="primary" icon="plus">
                Artikel
              </Button>
            </>
          }
        />
      }
    >
      <Pane
        label="Inventar"
        status={
          <>
            <FilterBar
              query={inventoryQuery}
              state={state()}
              onChange={change}
              icons={{
                status: "circle-dashed",
                title: "letter-case",
                price: "currency-euro",
                estimate: "scale",
                received: "calendar",
                due: "calendar-due",
                seen: "eye",
                consignor: "user",
                origin: "map-pin",
                era: "hourglass",
                location: "building-warehouse",
                shelf: "layout-rows",
                photographed: "camera",
              }}
              names={{ consignor: CONSIGNORS }}
              results={`${rows().length} Artikel`}
            />
            <StatusRow
              lead={`${rows().length} von ${items.length} Artikeln`}
              filters={<ListOrder query={inventoryQuery} state={state()} onChange={change} />}
            />
          </>
        }
      >
        <Table
          label="Inventar"
          rows={rows()}
          rowKey={(row) => row.nr}
          empty={{ icon: "filter-off", text: "Kein Artikel passt zu diesen Filtern." }}
          phone={(row) => ({
            lines: [row.title, `${row.nr} · ${label(LOCATIONS, row.location)}`],
            time: `${row.price.toLocaleString("de-DE")} €`,
          })}
          columns={[
            { title: "Nummer", width: { min: 100, default: 110 }, cell: (row) => row.nr, drop: true },
            { title: "Artikel", width: { min: 180, default: 260 }, cell: (row) => row.title },
            { title: "Epoche", width: { min: 90, default: 110 }, cell: (row) => label(ERAS, row.era) || "–", drop: true },
            {
              title: "Lagerort",
              width: { min: 90, default: 110 },
              cell: (row) => <Chip>{label(LOCATIONS, row.location)}</Chip>,
              drop: true,
            },
            { title: "Status", width: { min: 110, default: 130 }, cell: (row) => <Chip>{label(STATUS, row.status)}</Chip> },
            {
              title: "Fällig",
              width: { min: 90, default: 110 },
              cell: (row) => (row.due ? new Date(`${row.due}T00:00Z`).toLocaleDateString("de-DE", { timeZone: "UTC" }) : "–"),
              drop: true,
            },
            { title: "Preis", width: { min: 90, default: 100 }, align: "end", cell: (row) => `${row.price.toLocaleString("de-DE")} €` },
          ]}
        />
      </Pane>
    </Workspace>
  );
}
