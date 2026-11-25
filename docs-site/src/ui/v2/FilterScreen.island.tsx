import {
  Bar,
  Button,
  Chip,
  FilterBar,
  type FilterBarViews,
  Input,
  ListOrder,
  Nav,
  Pane,
  StatusRow,
  Table,
  Tabs,
  viewIcon,
  Workspace,
} from "@k2b/ui/v2";
import { defineListQuery, field, type LookupItem, type SavedListView, type ViewStore } from "@k2b/ui/v2/list-query";
import { createMemo, createSignal, type JSX } from "solid-js";

// The three cases of the approved filter concept (ui-v2-filter-konzept v4) on invented data, each one declaration of
// `defineListQuery` with FilterBar, ListOrder and a Table: Artikel (fixed values, a range, a lookup, views "für mich"
// and "für alle"), Protokolle (a required period, a fixed order, views only on this device) and Benutzer (a lookup of
// groups, yes/no, no view store). The page filters in the browser only because it is a demo: a real app filters on its
// server with the same declaration and reads the address with `parse`.

/** Waits like a server, and stops when the lookup aborts. */
const later = <T,>(signal: AbortSignal, value: () => T, ms = 300) =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => resolve(value()), ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason);
    });
  });
const search = (items: readonly LookupItem[]) => (query: string, context: { signal: AbortSignal; limit: number }) =>
  later(context.signal, () => ({
    items: items.filter((item) => item.label.toLowerCase().includes(query.toLowerCase())).slice(0, context.limit),
  }));
const names = (items: readonly LookupItem[]) => (values: readonly string[], context: { signal: AbortSignal }) =>
  later(context.signal, () => items.filter((item) => values.includes(item.value)), 0);

/** A store in memory, as an app keeps views in a cookie or its own table. */
const memoryStore = (scope: ViewStore["scope"], writable: boolean, views: SavedListView[]): ViewStore => ({
  scope,
  writable,
  list: async () => views,
  save: async (view) => {
    const saved = { key: view.key ?? `${scope}-${views.length + 1}`, label: view.label, query: view.query };
    const index = views.findIndex((existing) => existing.key === saved.key);
    if (index >= 0) views[index] = saved;
    else views.push(saved);
    return saved;
  },
  remove: async (key) => {
    const index = views.findIndex((view) => view.key === key);
    if (index >= 0) views.splice(index, 1);
  },
});

const labelOf = (options: readonly { value: string; label: string }[], code: string) =>
  options.find((option) => option.value === code)?.label ?? code;
const within = (chosen: readonly string[] | undefined, value: string) => chosen === undefined || chosen.includes(value);
const euro = (amount: number) => `${amount.toLocaleString("de-DE")} €`;

/** The frame every case shares: the app's sidebar, a head with views, search and the one main action. */
const Frame = (props: {
  app: string;
  icon: string;
  nav: { label: string; icon: string }[];
  tabs: { label: string; count?: number; icon?: string; current?: boolean; href?: string }[];
  search: string;
  primary?: string;
  status: JSX.Element;
  children: JSX.Element;
}) => (
  <Workspace
    sidebar={
      <Nav title={props.app} icon={props.icon} groups={[{ items: props.nav.map((item, index) => ({ ...item, current: index === 0 })) }]} />
    }
    head={
      <Bar
        start={<Tabs label="Ansichten" items={props.tabs} />}
        end={
          <>
            <Input type="search" icon="search" label={props.search} placeholder={props.search} />
            {props.primary ? (
              <Button variant="primary" icon="plus">
                {props.primary}
              </Button>
            ) : undefined}
          </>
        }
      />
    }
    primary={props.primary ? { label: props.primary, icon: "plus" } : undefined}
  >
    <Pane label={props.app} status={props.status}>
      {props.children}
    </Pane>
  </Workspace>
);

// ── Artikel ────────────────────────────────────────────────────────────────────────────────────────────────────

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
  { value: "c-1007", label: "Peter Brandt", meta: "Emmendingen" },
];

const articleQuery = defineListQuery({
  key: "articles",
  fields: {
    status: field.choice({ label: "Status", options: STATUS, common: true, counts: true }),
    category: field.choice({ label: "Kategorie", options: CATEGORIES, common: true }),
    location: field.choice({ label: "Lagerort", options: LOCATIONS, common: true }),
    price: field.numberRange({ label: "Preis", unit: "€", common: true, presets: [{ max: 500 }, { min: 500, max: 2000 }, { min: 2000 }] }),
    consignor: field.lookup({ label: "Einlieferer", common: true, limit: 6, load: search(CONSIGNORS), resolve: names(CONSIGNORS) }),
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
    options: { price: { label: "Preis", directions: ["desc", "asc"] }, received: { label: "Eingang", directions: ["desc", "asc"] } },
    default: { field: "received", direction: "desc" },
  },
  group: { status: { label: "Status" }, location: { label: "Lagerort" } },
});

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
const articles: Article[] = [
  ["A-26-0608", "Spiegel mit Goldrahmen", "furniture", "c-1004", "hall-a", "photographed", "2026-10-24", 1970],
  ["A-26-0664", "Sitzbank, Kirschbaum", "furniture", "c-1004", "hall-b", "photographed", "2026-09-15", 3050],
  ["A-26-0489", "Kaminuhr, Bronze vergoldet", "clocks", "c-1002", "hall-b", "consigned", "2026-10-20", 1800],
  ["A-26-0447", "Jugendstil-Vitrine", "furniture", "c-1007", "shop", "photographed", "2026-11-22", 1720],
  ["A-26-0475", "Kleiderschrank, zweitürig", "furniture", "c-1005", "shop", "consigned", "2026-11-01", 1570],
  ["A-26-0454", "Esstisch, ausziehbar, Eiche", "furniture", "c-1006", "shop", "photographed", "2026-11-03", 810],
  ["A-26-0671", "Ladenregal, Apotheke", "furniture", "c-1001", "workshop", "consigned", "2026-09-24", 3510],
  ["A-26-0440", "Schreibsekretär, Mahagoni", "furniture", "c-1006", "workshop", "consigned", "2026-10-03", 3310],
  ["A-26-0461", "Nierentisch mit Messingfüßen", "furniture", "c-1004", "workshop", "consigned", "2026-10-22", 2590],
  ["A-26-0566", "Aquarell „Rheinufer“", "paintings", "c-1004", "hall-a", "online", "2026-10-23", 2140],
  ["A-26-0643", "Sammeltasse mit Untertasse", "porcelain", "c-1003", "shop", "sold", "2026-10-20", 270],
  ["A-26-0552", "Ölbild „Feldberg im Winter“", "paintings", "c-1005", "hall-b", "online", "2026-09-26", 1200],
].map(([nr, title, category, consignor, location, status, received, price]) => ({
  nr: String(nr),
  title: String(title),
  category: String(category),
  consignor: String(consignor),
  location: String(location),
  status: String(status),
  received: String(received),
  price: Number(price),
}));

const articleViews: FilterBarViews["stores"] = [memoryStore("person", true, []), memoryStore("app", false, [])];

const Articles = (props: { search: string }) => {
  const [state, setState] = createSignal(articleQuery.parse(props.search).state);
  const rows = createMemo(() => {
    const filters = state().filters;
    const list = articles.filter(
      (article) =>
        within(filters.status, article.status) &&
        within(filters.category, article.category) &&
        within(filters.location, article.location) &&
        within(filters.consignor, article.consignor) &&
        (filters.price?.min === undefined || article.price >= filters.price.min) &&
        (filters.price?.max === undefined || article.price <= filters.price.max),
    );
    const sign = state().sort.direction === "asc" ? 1 : -1;
    list.sort((a, b) => (state().sort.field === "price" ? (a.price - b.price) * sign : a.received.localeCompare(b.received) * sign));
    const group = state().group;
    if (group) list.sort((a, b) => a[group].localeCompare(b[group]));
    return list;
  });
  const groupWords = (row: Article) => (state().group === "status" ? labelOf(STATUS, row.status) : labelOf(LOCATIONS, row.location));
  const groupKey = (row: Article) => (state().group === "status" ? row.status : row.location);
  return (
    <Frame
      app="Warenfluss"
      icon="building-warehouse"
      nav={[
        { label: "Artikel", icon: "armchair" },
        { label: "Einlieferungen", icon: "truck-delivery" },
        { label: "Einlieferer", icon: "address-book" },
        { label: "Verkäufe", icon: "receipt" },
      ]}
      tabs={[
        { label: "Alle", count: articles.length, current: true, href: "?" },
        { label: "Zu fotografieren", count: 7, href: "?status=consigned" },
        { label: "Online", count: 2, href: "?status=online" },
        { label: "Teure Möbel", icon: viewIcon("person"), count: 5, href: "?category=furniture&price=2000.." },
      ]}
      search="Nummer oder Titel"
      primary="Artikel"
      status={
        <>
          <FilterBar
            query={articleQuery}
            state={state()}
            onChange={setState}
            icons={{
              status: "circle-dashed",
              category: "category",
              location: "building-warehouse",
              price: "currency-euro",
              consignor: "user",
              received: "calendar",
            }}
            counts={{ status: { consigned: 5, photographed: 4, online: 2, reserved: 0, sold: 1 } }}
            names={{ consignor: CONSIGNORS }}
            views={{ stores: articleViews }}
            results={`${rows().length} Artikel`}
          />
          <StatusRow
            lead={`${rows().length} von ${articles.length} Artikeln`}
            facts={[{ before: "Wert", value: euro(rows().reduce((sum, row) => sum + row.price, 0)) }]}
            filters={<ListOrder query={articleQuery} state={state()} onChange={setState} />}
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
            ? (row) => ({
                key: groupKey(row),
                head: () => <Chip>{groupWords(row)}</Chip>,
                meta: `Wert ${euro(
                  rows()
                    .filter((other) => groupKey(other) === groupKey(row))
                    .reduce((sum, other) => sum + other.price, 0),
                )}`,
                count: String(rows().filter((other) => groupKey(other) === groupKey(row)).length),
              })
            : undefined
        }
        empty={{ icon: "filter-off", text: "Kein Artikel passt zu diesen Filtern." }}
        phone={(row) => ({
          lines: [row.title, `${row.nr} · ${labelOf(CATEGORIES, row.category)} · ${labelOf(LOCATIONS, row.location)}`],
          time: euro(row.price),
        })}
        columns={[
          { title: "Nummer", width: { min: 100, default: 110 }, cell: (row) => row.nr, drop: true },
          { title: "Artikel", width: { min: 180, default: 250 }, cell: (row) => row.title },
          { title: "Kategorie", width: { min: 90, default: 100 }, cell: (row) => labelOf(CATEGORIES, row.category), drop: true },
          { title: "Einlieferer", width: { min: 120, default: 160 }, cell: (row) => labelOf(CONSIGNORS, row.consignor), drop: true },
          {
            title: "Lagerort",
            width: { min: 90, default: 110 },
            cell: (row) => <Chip>{labelOf(LOCATIONS, row.location)}</Chip>,
            drop: true,
          },
          { title: "Status", width: { min: 110, default: 130 }, cell: (row) => <Chip>{labelOf(STATUS, row.status)}</Chip> },
          { title: "Preis", width: { min: 90, default: 100 }, align: "end", cell: (row) => euro(row.price) },
        ]}
      />
    </Frame>
  );
};

// ── Protokolle ─────────────────────────────────────────────────────────────────────────────────────────────────

const LEVELS = [
  { value: "error", label: "Fehler" },
  { value: "warn", label: "Warnung" },
  { value: "info", label: "Info" },
] as const;
const SOURCES: readonly LookupItem[] = [
  { value: "mail", label: "mail", meta: "Mail" },
  { value: "gateway", label: "gateway", meta: "Gateway" },
  { value: "files", label: "files", meta: "Dateien" },
  { value: "core", label: "core", meta: "Anmeldung" },
];

const logQuery = defineListQuery({
  key: "logs",
  fields: {
    time: field.timeRange({
      label: "Zeitraum",
      common: true,
      presets: [
        { value: "last-15m", label: "letzte 15 Minuten" },
        { value: "last-1h", label: "letzte Stunde" },
        { value: "last-24h", label: "letzte 24 Stunden" },
      ],
      required: { kind: "preset", preset: "last-15m" },
    }),
    level: field.choice({ label: "Stufe", options: LEVELS, common: true }),
    source: field.lookup({ label: "Quelle", common: true, load: search(SOURCES), resolve: names(SOURCES) }),
    request: field.text({ label: "Request-ID" }),
    duration: field.numberRange({ label: "Dauer", unit: "ms", presets: [{ min: 1000 }] }),
  },
  sort: { fixed: { field: "time", direction: "desc", label: "neueste zuerst" } },
  group: { source: { label: "Quelle" } },
});

type Entry = { time: string; level: string; source: string; text: string; request: string; ms: number };
const entries: Entry[] = [
  { time: "11:58:41", level: "error", source: "mail", text: "Zustellung an mx.example.net abgelehnt (550)", request: "7f3a9c", ms: 1240 },
  { time: "11:58:12", level: "warn", source: "gateway", text: "Langsame Antwort von files", request: "a91b02", ms: 2310 },
  { time: "11:57:55", level: "info", source: "core", text: "Anmeldung mit Passkey", request: "c40e11", ms: 84 },
  { time: "11:57:30", level: "warn", source: "mail", text: "Postfach fast voll (92 %)", request: "d2f7aa", ms: 41 },
  { time: "11:56:02", level: "info", source: "files", text: "Ordner „Belege 2026“ geteilt", request: "e5c219", ms: 66 },
  { time: "11:55:47", level: "error", source: "files", text: "Hochladen abgebrochen: Verbindung getrennt", request: "f00b31", ms: 15020 },
];

const logViews: FilterBarViews["stores"] = [memoryStore("device", true, [])];

const Logs = (props: { search: string }) => {
  const [state, setState] = createSignal(logQuery.parse(props.search).state);
  const rows = createMemo(() => {
    const filters = state().filters;
    return entries.filter(
      (entry) =>
        within(filters.level, entry.level) &&
        within(filters.source, entry.source) &&
        (filters.request === undefined || entry.request.startsWith(filters.request)) &&
        (filters.duration?.min === undefined || entry.ms >= filters.duration.min) &&
        (filters.duration?.max === undefined || entry.ms <= filters.duration.max),
    );
  });
  const errors = () => rows().filter((row) => row.level === "error").length;
  return (
    <Frame
      app="Betrieb"
      icon="activity"
      nav={[
        { label: "Protokolle", icon: "list-details" },
        { label: "Dienste", icon: "server" },
        { label: "Warnungen", icon: "bell" },
      ]}
      tabs={[
        { label: "Alle", current: true, href: "?" },
        { label: "Nur Fehler", href: "?level=error" },
      ]}
      search="Text im Protokoll"
      status={
        <>
          <FilterBar
            query={logQuery}
            state={state()}
            onChange={setState}
            icons={{ time: "clock", level: "alert-triangle", source: "plug", request: "hash", duration: "hourglass" }}
            names={{ source: SOURCES }}
            views={{ stores: logViews }}
            results={`${rows().length} Einträge`}
          />
          <StatusRow
            lead={`${rows().length} Einträge`}
            facts={[{ value: errors(), after: "Fehler" }]}
            filters={<ListOrder query={logQuery} state={state()} onChange={setState} />}
          />
        </>
      }
    >
      <Table
        label="Protokolle"
        rows={rows()}
        rowKey={(row) => row.request}
        group={
          state().group
            ? (row) => ({
                key: row.source,
                head: () => <Chip>{row.source}</Chip>,
                count: String(rows().filter((other) => other.source === row.source).length),
              })
            : undefined
        }
        empty={{ icon: "filter-off", text: "Kein Eintrag passt zu diesen Filtern." }}
        phone={(row) => ({ lines: [row.text, `${row.source} · ${labelOf(LEVELS, row.level)} · ${row.request}`], time: row.time })}
        columns={[
          { title: "Zeit", width: { min: 80, default: 90 }, cell: (row) => row.time },
          {
            title: "Stufe",
            width: { min: 90, default: 100 },
            cell: (row) =>
              row.level === "info" ? (
                <Chip>{labelOf(LEVELS, row.level)}</Chip>
              ) : (
                <Chip status={row.level === "error" ? "bad" : "warn"}>{labelOf(LEVELS, row.level)}</Chip>
              ),
          },
          { title: "Quelle", width: { min: 80, default: 100 }, cell: (row) => row.source, drop: true },
          { title: "Meldung", width: { min: 220, default: 380 }, cell: (row) => row.text },
          { title: "Request-ID", width: { min: 90, default: 110 }, cell: (row) => row.request, drop: true },
          {
            title: "Dauer",
            width: { min: 80, default: 90 },
            align: "end",
            cell: (row) => `${row.ms.toLocaleString("de-DE")} ms`,
            drop: true,
          },
        ]}
      />
    </Frame>
  );
};

// ── Benutzer ───────────────────────────────────────────────────────────────────────────────────────────────────

const ROLES = [
  { value: "admin", label: "Verwaltung" },
  { value: "member", label: "Mitglied" },
  { value: "guest", label: "Gast" },
] as const;
const STATES = [
  { value: "active", label: "Aktiv" },
  { value: "invited", label: "Eingeladen" },
  { value: "locked", label: "Gesperrt" },
] as const;
const GROUPS: readonly LookupItem[] = [
  { value: "g-lager", label: "Lager", meta: "8 Personen" },
  { value: "g-laden", label: "Laden", meta: "5 Personen" },
  { value: "g-buero", label: "Büro", meta: "4 Personen" },
  { value: "g-foto", label: "Fotostudio", meta: "2 Personen" },
];

const peopleQuery = defineListQuery({
  key: "people",
  fields: {
    role: field.choice({ label: "Rolle", options: ROLES, common: true }),
    // "group" is the grouping's own parameter, so the field of groups has another key
    groups: field.lookup({ label: "Gruppe", common: true, load: search(GROUPS), resolve: names(GROUPS) }),
    state: field.choice({ label: "Status", options: STATES, common: true }),
    lastLogin: field.dateRange({
      label: "Letzte Anmeldung",
      presets: [
        { value: "last-7d", label: "letzte 7 Tage" },
        { value: "older-90d", label: "vor über 90 Tagen" },
      ],
    }),
    twofa: field.bool({ label: "2FA", labels: { yes: "an", no: "aus" } }),
  },
  search: { label: "Name oder E-Mail" },
  sort: {
    options: { name: { label: "Name", directions: ["asc", "desc"] }, active: { label: "Zuletzt aktiv", directions: ["desc", "asc"] } },
    default: { field: "name", direction: "asc" },
  },
  group: { groups: { label: "Gruppe" } },
});

type Person = { name: string; email: string; role: string; groups: string[]; state: string; twofa: boolean; active: string };
const people: Person[] = [
  {
    name: "Mira Solberg",
    email: "mira@warenfluss.example",
    role: "admin",
    groups: ["g-buero"],
    state: "active",
    twofa: true,
    active: "heute",
  },
  {
    name: "Jule Amsel",
    email: "jule@warenfluss.example",
    role: "member",
    groups: ["g-lager", "g-foto"],
    state: "active",
    twofa: false,
    active: "gestern",
  },
  {
    name: "Henrik Brandt",
    email: "henrik@warenfluss.example",
    role: "member",
    groups: ["g-lager"],
    state: "active",
    twofa: true,
    active: "vor 3 Tagen",
  },
  {
    name: "Ada Renz",
    email: "ada@warenfluss.example",
    role: "member",
    groups: ["g-laden"],
    state: "invited",
    twofa: false,
    active: "noch nie",
  },
  {
    name: "Tomas Wiegand",
    email: "tomas@warenfluss.example",
    role: "guest",
    groups: ["g-laden", "g-lager"],
    state: "active",
    twofa: false,
    active: "vor 2 Wochen",
  },
  {
    name: "Lea Fürst",
    email: "lea@warenfluss.example",
    role: "member",
    groups: ["g-foto"],
    state: "locked",
    twofa: true,
    active: "vor 4 Monaten",
  },
];

const People = (props: { search: string }) => {
  const [state, setState] = createSignal(peopleQuery.parse(props.search).state);
  const rows = createMemo(() => {
    const filters = state().filters;
    const list = people.filter(
      (person) =>
        within(filters.role, person.role) &&
        within(filters.state, person.state) &&
        (filters.groups === undefined || person.groups.some((group) => filters.groups?.includes(group))) &&
        (filters.twofa === undefined || person.twofa === filters.twofa),
    );
    const sign = state().sort.direction === "asc" ? 1 : -1;
    list.sort((a, b) => a.name.localeCompare(b.name) * sign);
    // grouped by group, a person stands in each of their groups
    if (!state().group) return list.map((person) => ({ person, group: "" }));
    return GROUPS.flatMap((group) =>
      list.filter((person) => person.groups.includes(group.value)).map((person) => ({ person, group: group.value })),
    );
  });
  const several = () => (state().group ? people.filter((person) => person.groups.length > 1).length : 0);
  return (
    <Frame
      app="Benutzer"
      icon="users"
      nav={[
        { label: "Personen", icon: "users" },
        { label: "Gruppen", icon: "users-group" },
        { label: "Agenten", icon: "robot" },
      ]}
      tabs={[
        { label: "Alle", count: people.length, current: true, href: "?" },
        { label: "Ohne 2FA", href: "?twofa=no" },
      ]}
      search="Name oder E-Mail"
      primary="Einladen"
      status={
        <>
          <FilterBar
            query={peopleQuery}
            state={state()}
            onChange={setState}
            icons={{ role: "shield", groups: "users-group", state: "circle-dashed", lastLogin: "login", twofa: "lock" }}
            names={{ groups: GROUPS }}
            results={`${new Set(rows().map((row) => row.person.email)).size} Personen`}
          />
          <StatusRow
            lead={`${new Set(rows().map((row) => row.person.email)).size} Personen`}
            facts={several() > 0 ? [{ value: several(), after: "davon in mehreren Gruppen, sie stehen mehrfach" }] : []}
            filters={<ListOrder query={peopleQuery} state={state()} onChange={setState} />}
          />
        </>
      }
    >
      <Table
        label="Personen"
        rows={rows()}
        rowKey={(row) => `${row.group}:${row.person.email}`}
        group={
          state().group
            ? (row) => ({
                key: row.group,
                head: () => <Chip>{labelOf(GROUPS, row.group)}</Chip>,
                count: String(rows().filter((other) => other.group === row.group).length),
              })
            : undefined
        }
        empty={{ icon: "filter-off", text: "Keine Person passt zu diesen Filtern." }}
        phone={(row) => ({ lines: [row.person.name, `${labelOf(ROLES, row.person.role)} · ${row.person.email}`], time: row.person.active })}
        columns={[
          { title: "Name", width: { min: 140, default: 180 }, cell: (row) => row.person.name },
          { title: "E-Mail", width: { min: 180, default: 230 }, cell: (row) => row.person.email, drop: true },
          { title: "Rolle", width: { min: 90, default: 110 }, cell: (row) => labelOf(ROLES, row.person.role) },
          {
            title: "Status",
            width: { min: 100, default: 120 },
            cell: (row) => (
              <Chip status={row.person.state === "locked" ? "bad" : row.person.state === "invited" ? "warn" : "ok"}>
                {labelOf(STATES, row.person.state)}
              </Chip>
            ),
          },
          { title: "2FA", width: { min: 60, default: 70 }, cell: (row) => (row.person.twofa ? "an" : "aus"), drop: true },
          { title: "Zuletzt aktiv", width: { min: 100, default: 120 }, align: "end", cell: (row) => row.person.active, drop: true },
        ]}
      />
    </Frame>
  );
};

/** One of the three cases; `search` is the address the server read, so the first picture shows its filters. */
export default function FilterScreen(props: { list: "articles" | "logs" | "people"; search: string }) {
  if (props.list === "logs") return <Logs search={props.search} />;
  if (props.list === "people") return <People search={props.search} />;
  return <Articles search={props.search} />;
}
