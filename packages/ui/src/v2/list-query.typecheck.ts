import {
  defineListQuery,
  field,
  type ListQueryStateOf,
  type LookupItem,
  type NumberRange,
  type PeriodValue,
  type SortDirection,
} from "./list-query";

type Expect<T extends true> = T;
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

const noItems = async (): Promise<readonly LookupItem[]> => [];

const query = defineListQuery({
  key: "articles",
  fields: {
    status: field.choice({
      label: "Status",
      options: [
        { value: "open", label: "Open" },
        { value: "sold", label: "Sold" },
      ],
    }),
    location: field.choice({
      label: "Location",
      multiple: false,
      options: [
        { value: "a", label: "A" },
        { value: "b", label: "B" },
      ],
    }),
    consignor: field.lookup({ label: "Consignor", load: async () => ({ items: [] }), resolve: noItems }),
    owner: field.lookup({ label: "Owner", multiple: false, load: async () => ({ items: [] }), resolve: noItems }),
    price: field.numberRange({ label: "Price", unit: "€" }),
    received: field.dateRange({ label: "Received", presets: [{ value: "last-7d", label: "Last 7 days" }] }),
    time: field.timeRange({
      label: "Time",
      presets: [
        { value: "last-15m", label: "Last 15 minutes" },
        { value: "last-1h", label: "Last hour" },
      ],
      required: { kind: "preset", preset: "last-15m" },
    }),
    twofa: field.bool({ label: "2FA", labels: { yes: "on", no: "off" } }),
    request: field.text({ label: "Request" }),
  },
  search: { label: "Search" },
  sort: { options: { price: { label: "Price" }, received: { label: "Received" } }, default: { field: "received", direction: "desc" } },
  group: { status: { label: "Status" }, location: { label: "Location" } },
});

type State = ListQueryStateOf<typeof query>;
const { state } = query.parse("");

export type ParsedTypes = [
  Expect<Equal<typeof state, State>>,
  Expect<Equal<State["filters"]["status"], readonly ("open" | "sold")[] | undefined>>,
  Expect<Equal<State["filters"]["location"], "a" | "b" | undefined>>,
  Expect<Equal<State["filters"]["consignor"], readonly string[] | undefined>>,
  Expect<Equal<State["filters"]["owner"], string | undefined>>,
  Expect<Equal<State["filters"]["price"], NumberRange | undefined>>,
  Expect<Equal<State["filters"]["received"], PeriodValue<"last-7d"> | undefined>>,
  // A mandatory field is always present.
  Expect<Equal<State["filters"]["time"], PeriodValue<"last-15m" | "last-1h">>>,
  Expect<Equal<State["filters"]["twofa"], boolean | undefined>>,
  Expect<Equal<State["filters"]["request"], string | undefined>>,
  Expect<Equal<State["sort"], { readonly field: "price" | "received"; readonly direction: SortDirection }>>,
  Expect<Equal<State["group"], "status" | "location" | undefined>>,
  Expect<
    Equal<keyof State["filters"], "status" | "location" | "consignor" | "owner" | "price" | "received" | "time" | "twofa" | "request">
  >,
];

query.set(state, "status", ["open"]);
query.set(state, "location", "b");
// @ts-expect-error: a value the declaration does not know
query.set(state, "status", ["gone"]);
// @ts-expect-error: a single choice takes one value, not a list
query.set(state, "location", ["a"]);
// @ts-expect-error: no such field
query.clear(state, "missing");

defineListQuery({
  key: "logs",
  fields: {},
  // @ts-expect-error: the default sort must be one of the options
  sort: { options: { time: { label: "Time" } }, default: { field: "other", direction: "desc" } },
});

field.choice({
  label: "Status",
  options: [{ value: "open", label: "Open" }],
  // @ts-expect-error: a mandatory value must be a declared value
  required: ["closed"],
});

const logs = defineListQuery({
  key: "logs",
  fields: { level: field.choice({ label: "Level", options: [{ value: "error", label: "Error" }] }) },
  sort: { fixed: { field: "time", direction: "desc", label: "Newest first" } },
});
const logState = logs.reset();
export type FixedTypes = [Expect<Equal<(typeof logState)["sort"]["field"], "time">>, Expect<Equal<(typeof logState)["group"], undefined>>];

// Explicit type parameters must match the properties, so the type never claims what the runtime does not do.
// @ts-expect-error: a single choice needs multiple: false
field.choice<"a", false>({ label: "A", options: [{ value: "a", label: "A" }] });
field.choice<"a", false>({ label: "A", multiple: false, options: [{ value: "a", label: "A" }] });
// @ts-expect-error: a single lookup needs multiple: false
field.lookup<false>({ label: "Who", load: async () => ({ items: [] }), resolve: noItems });
// @ts-expect-error: a mandatory type needs its required value
field.bool<true>({ label: "2FA", labels: { yes: "on", no: "off" } });
field.bool<true>({ label: "2FA", labels: { yes: "on", no: "off" }, required: true });
// @ts-expect-error: a mandatory type needs its required value
field.text<"x">({ label: "Request" });
