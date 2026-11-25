import { createMemo, createSignal } from "solid-js";
import { isServer } from "solid-js/web";
import { Bar, Button, Chip, FilterBar, Input, ListOrder, Pane, StatusRow, Table, Tabs, Workspace } from "../src/v2";
import { defineListQuery, field, type ListQueryStateOf, type LookupItem, type SavedListView, type ViewStore } from "../src/v2/list-query";

// The Artikel list of the approved filter concept on invented data: fixed values, a range, a lookup that loads, a
// period, sort and group, and two view stores ("für mich", "für alle"). The page filters in the browser only because
// it is a fixture; a real app filters on its server with the same declaration. Every load of the lookup waits for the
// test (`window.__lookup`), so a test decides when it answers, fails or is aborted.

type Article = {
  nr: string;
  title: string;
  category: string;
  consignor: string;
  location: string;
  status: string;
  received: string;
  price: number;
};

const STATUS = [
  { value: "consigned", label: "Eingeliefert" },
  { value: "photographed", label: "Fotografiert" },
  { value: "online", label: "Online" },
  { value: "reserved", label: "Reserviert" },
  { value: "sold", label: "Verkauft" },
] as const;
const CATEGORIES = [
  { value: "furniture", label: "Möbel" },
  { value: "clocks", label: "Uhren" },
  { value: "paintings", label: "Gemälde" },
  { value: "porcelain", label: "Porzellan" },
] as const;
const LOCATIONS = [
  { value: "hall-a", label: "Halle A" },
  { value: "hall-b", label: "Halle B" },
  { value: "shop", label: "Laden" },
  { value: "workshop", label: "Werkstatt" },
] as const;
const CONSIGNORS: readonly LookupItem[] = [
  { value: "c-1001", label: "Haus Bergmann", meta: "Freiburg" },
  { value: "c-1002", label: "Bergmann & Söhne", meta: "Offenburg" },
  { value: "c-1003", label: "Haus am Bergsee", meta: "Titisee" },
  { value: "c-1004", label: "Antik Weber KG", meta: "Kehl" },
  { value: "c-1005", label: "Nachlass Kessler", meta: "Waldkirch" },
  { value: "c-1006", label: "Gräfin von Thal", meta: "Lahr" },
];

const articles: Article[] = [
  {
    nr: "A-26-0608",
    title: "Spiegel mit Goldrahmen",
    category: "furniture",
    consignor: "c-1004",
    location: "hall-a",
    status: "photographed",
    received: "2026-10-24",
    price: 1970,
  },
  {
    nr: "A-26-0664",
    title: "Sitzbank, Kirschbaum",
    category: "furniture",
    consignor: "c-1004",
    location: "hall-b",
    status: "photographed",
    received: "2026-09-15",
    price: 3050,
  },
  {
    nr: "A-26-0489",
    title: "Kaminuhr, Bronze vergoldet",
    category: "clocks",
    consignor: "c-1002",
    location: "hall-b",
    status: "consigned",
    received: "2026-10-20",
    price: 1800,
  },
  {
    nr: "A-26-0447",
    title: "Jugendstil-Vitrine",
    category: "furniture",
    consignor: "c-1001",
    location: "shop",
    status: "photographed",
    received: "2026-11-22",
    price: 1720,
  },
  {
    nr: "A-26-0475",
    title: "Kleiderschrank, zweitürig",
    category: "furniture",
    consignor: "c-1005",
    location: "shop",
    status: "consigned",
    received: "2026-11-01",
    price: 1570,
  },
  {
    nr: "A-26-0454",
    title: "Esstisch, ausziehbar, Eiche",
    category: "furniture",
    consignor: "c-1006",
    location: "shop",
    status: "photographed",
    received: "2026-11-03",
    price: 810,
  },
  {
    nr: "A-26-0671",
    title: "Ladenregal, Apotheke",
    category: "furniture",
    consignor: "c-1001",
    location: "workshop",
    status: "consigned",
    received: "2026-09-24",
    price: 3510,
  },
  {
    nr: "A-26-0440",
    title: "Schreibsekretär, Mahagoni",
    category: "furniture",
    consignor: "c-1006",
    location: "workshop",
    status: "consigned",
    received: "2026-10-03",
    price: 3310,
  },
  {
    nr: "A-26-0566",
    title: "Aquarell „Rheinufer“",
    category: "paintings",
    consignor: "c-1004",
    location: "hall-a",
    status: "online",
    received: "2026-10-23",
    price: 2140,
  },
  {
    nr: "A-26-0643",
    title: "Sammeltasse mit Untertasse",
    category: "porcelain",
    consignor: "c-1003",
    location: "shop",
    status: "sold",
    received: "2026-10-20",
    price: 270,
  },
];

type Pending = { query: string; signal: AbortSignal; resolve: () => void; reject: () => void };
declare global {
  interface Window {
    __lookup?: { calls: { query: string; aborted: () => boolean }[]; answer: () => void; fail: () => void };
    __changes?: string[];
    /** How often the consignor names were resolved, and the codes asked for. */
    __resolves?: string[][];
    /** While true, every write of a view store fails, as a server that refuses would. */
    __failStore?: boolean;
    /** What took the focus, in order (a test records it). */
    __focus?: string[];
  }
}
const pending: Pending[] = [];
const lookupHooks = () => {
  if (isServer) return;
  window.__lookup ??= {
    calls: [],
    answer: () => pending.shift()?.resolve(),
    fail: () => pending.shift()?.reject(),
  };
};

const loadConsignors = (query: string, context: { signal: AbortSignal; limit: number }) =>
  new Promise<{ items: readonly LookupItem[]; counts?: Readonly<Record<string, number>> }>((resolve, reject) => {
    lookupHooks();
    window.__lookup?.calls.push({ query, aborted: () => context.signal.aborted });
    const entry: Pending = {
      query,
      signal: context.signal,
      resolve: () => {
        const words = query.toLowerCase();
        const items = CONSIGNORS.filter((item) => item.label.toLowerCase().includes(words)).slice(0, context.limit);
        resolve({
          items,
          counts: Object.fromEntries(items.map((item) => [item.value, articles.filter((a) => a.consignor === item.value).length])),
        });
      },
      reject: () => reject(new Error("offline")),
    };
    context.signal.addEventListener("abort", () => {
      const index = pending.indexOf(entry);
      if (index >= 0) pending.splice(index, 1);
    });
    pending.push(entry);
  });

const BUYERS: readonly LookupItem[] = [
  { value: "c-1001", label: "Lena Hof", meta: "Basel" },
  { value: "c-2002", label: "Galerie Nord", meta: "Kiel" },
];

export const articleQuery = defineListQuery({
  key: "articles",
  fields: {
    status: field.choice({ label: "Status", options: STATUS, common: true, counts: true }),
    category: field.choice({ label: "Kategorie", options: CATEGORIES, common: true }),
    location: field.choice({ label: "Lagerort", options: LOCATIONS, common: true }),
    price: field.numberRange({ label: "Preis", unit: "€", common: true, presets: [{ max: 500 }, { min: 500, max: 2000 }, { min: 2000 }] }),
    consignor: field.lookup({
      label: "Einlieferer",
      common: true,
      limit: 6,
      load: loadConsignors,
      resolve: async (values) => {
        if (!isServer) window.__resolves = [...(window.__resolves ?? []), [...values]];
        return CONSIGNORS.filter((item) => values.includes(item.value));
      },
    }),
    // a second lookup whose codes look like the consignors' ("c-1001"), with other names
    buyer: field.lookup({
      label: "Käufer",
      load: async () => ({ items: BUYERS }),
      resolve: async (values) => BUYERS.filter((item) => values.includes(item.value)),
    }),
    // points in time, shown in the time zone the app passes (`_tz` in the address of this demo)
    seen: field.timeRange({ label: "Gesehen", presets: [{ value: "last-1h", label: "letzte Stunde" }] }),
    received: field.dateRange({
      label: "Eingang",
      presets: [
        { value: "last-7d", label: "letzte 7 Tage" },
        { value: "last-30d", label: "letzte 30 Tage" },
      ],
    }),
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
});

type State = ListQueryStateOf<typeof articleQuery>;

/** A store in memory, as an app's cookie or table would hold it. */
const memoryStore = (scope: ViewStore["scope"], writable: boolean, views: SavedListView[]): ViewStore => ({
  scope,
  writable,
  list: async () => views,
  save: async (view) => {
    if (window.__failStore) throw new Error("");
    const saved = { key: view.key ?? `${scope}-${views.length + 1}`, label: view.label, query: view.query };
    const index = views.findIndex((existing) => existing.key === saved.key);
    if (index >= 0) views[index] = saved;
    else views.push(saved);
    window.__changes = [...(window.__changes ?? []), `saved ${scope} ${saved.label} ${saved.query}`];
    return saved;
  },
  remove: async (key) => {
    if (window.__failStore) throw new Error("");
    const index = views.findIndex((view) => view.key === key);
    if (index >= 0) views.splice(index, 1);
  },
});

const label = (options: readonly { value: string; label: string }[], code: string) => options.find((o) => o.value === code)?.label ?? code;

const within = (chosen: readonly string[] | undefined, value: string) => chosen === undefined || chosen.includes(value);

const matches = (article: Article, state: State) => {
  const filters = state.filters;
  if (!within(filters.status, article.status)) return false;
  if (!within(filters.category, article.category)) return false;
  if (!within(filters.location, article.location)) return false;
  if (!within(filters.consignor, article.consignor)) return false;
  if (filters.price?.min !== undefined && article.price < filters.price.min) return false;
  if (filters.price?.max !== undefined && article.price > filters.price.max) return false;
  return true;
};

export function Demo(props: { search?: string; stores?: boolean }) {
  const initial = articleQuery.parse(props.search ?? (isServer ? "" : location.search)).state;
  const [state, setState] = createSignal<State>(initial);
  // one saved view "für mich", opened with view=person-1: its stored query is what the view holds
  const saved = { key: "person-1", label: "Teure Möbel", query: "category=furniture&price=2000.." };
  const stores = props.stores === false ? undefined : [memoryStore("person", true, [saved]), memoryStore("app", false, [])];
  const timeZone = isServer ? undefined : (new URLSearchParams(location.search).get("_tz") ?? undefined);
  const rows = createMemo(() => {
    const list = articles.filter((article) => matches(article, state()));
    const sort = state().sort;
    const sign = sort.direction === "asc" ? 1 : -1;
    list.sort((a, b) => (sort.field === "price" ? (a.price - b.price) * sign : a.received.localeCompare(b.received) * sign));
    const group = state().group;
    if (group) list.sort((a, b) => a[group].localeCompare(b[group]));
    return list;
  });
  const results = () => `${rows().length} Artikel`;
  const change = (next: State) => {
    if (!isServer) window.__changes = [...(window.__changes ?? []), articleQuery.serialize(next).toString()];
    setState(next);
  };
  const value = () => rows().reduce((sum, article) => sum + article.price, 0);
  return (
    <Workspace
      head={
        <Bar
          start={
            <Tabs
              label="Ansichten"
              items={[
                { label: "Alle", count: 40, href: "?", current: !state().view },
                { label: "Zu fotografieren", count: 7, href: "?view=to-photo&status=consigned" },
                { label: "Online", count: 11, href: "?view=online&status=online" },
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
        label="Artikel"
        status={
          <>
            <FilterBar
              query={articleQuery}
              state={state()}
              onChange={change}
              icons={{
                status: "circle-dashed",
                category: "category",
                location: "building-warehouse",
                price: "currency-euro",
                consignor: "user",
                received: "calendar",
              }}
              counts={{ status: { consigned: 5, photographed: 4, online: 5, reserved: 3, sold: 2 } }}
              views={stores ? { stores, current: state().view === saved.key ? { ...saved, scope: "person" } : undefined } : undefined}
              timeZone={timeZone}
              results={results()}
            />
            <StatusRow
              lead={`${rows().length} von ${articles.length} Artikeln`}
              facts={[{ before: "Wert", value: `${value().toLocaleString("de-DE")} €` }]}
              filters={<ListOrder query={articleQuery} state={state()} onChange={change} />}
            />
          </>
        }
      >
        <Table
          label="Artikel"
          rows={rows()}
          rowKey={(row) => row.nr}
          group={
            state().group
              ? (row) => {
                  const key = state().group === "status" ? row.status : row.location;
                  const words = state().group === "status" ? label(STATUS, key) : label(LOCATIONS, key);
                  return {
                    key,
                    head: () => <Chip>{words}</Chip>,
                    count: String(rows().filter((r) => (state().group === "status" ? r.status : r.location) === key).length),
                  };
                }
              : undefined
          }
          empty={{ icon: "filter-off", text: "Kein Artikel passt zu diesen Filtern." }}
          phone={(row) => ({
            lines: [row.title, `${row.nr} · ${label(CATEGORIES, row.category)} · ${label(LOCATIONS, row.location)}`],
            time: `${row.price.toLocaleString("de-DE")} €`,
          })}
          columns={[
            { title: "Nummer", width: { min: 100, default: 110 }, cell: (row) => row.nr, drop: true },
            { title: "Artikel", width: { min: 180, default: 260 }, cell: (row) => row.title },
            { title: "Kategorie", width: { min: 90, default: 110 }, cell: (row) => label(CATEGORIES, row.category), drop: true },
            {
              title: "Lagerort",
              width: { min: 90, default: 110 },
              cell: (row) => <Chip>{label(LOCATIONS, row.location)}</Chip>,
              drop: true,
            },
            { title: "Status", width: { min: 110, default: 130 }, cell: (row) => <Chip>{label(STATUS, row.status)}</Chip> },
            { title: "Preis", width: { min: 90, default: 100 }, align: "end", cell: (row) => `${row.price.toLocaleString("de-DE")} €` },
          ]}
        />
      </Pane>
    </Workspace>
  );
}
