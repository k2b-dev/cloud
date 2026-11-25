/**
 * `@k2b/ui/v2/list-query`: the declared filters, sorts and groups of one list, and their URL.
 *
 * Explicit beats implicit. The application declares every filter field, value, sort and group with
 * {@link defineListQuery}; the URL holds the whole state, so reload, back and a shared link show the same list.
 * The module is pure TypeScript without DOM access or Solid, so server routes and islands import the same
 * declaration.
 *
 * The application filters itself: it reads the state with `parse`, queries its own data with its own access
 * checks, counts what it shows, and stores saved views wherever it chooses ({@link ViewStore}). `@k2b/ui` filters
 * nothing and stores nothing.
 *
 * ```ts
 * import { defineListQuery, field } from "@k2b/ui/v2/list-query";
 *
 * export const articleQuery = defineListQuery({
 *   key: "articles",
 *   fields: {
 *     status: field.choice({ label: t("Status"), options: STATUS_OPTIONS, common: true }),
 *     price: field.numberRange({ label: t("Price"), unit: "€" }),
 *     consignor: field.lookup({ label: t("Consignor"), load: searchConsignors, resolve: consignorNames }),
 *     received: field.dateRange({ label: t("Received"), presets: [{ value: "last-30d", label: t("Last 30 days") }] }),
 *   },
 *   search: { label: t("Number or title") },
 *   sort: { options: { received: { label: t("Received") }, price: { label: t("Price") } }, default: { field: "received", direction: "desc" } },
 *   group: { status: { label: t("Status") } },
 * });
 *
 * const { state, issues } = articleQuery.parse(new URL(c.req.url).searchParams);
 * ```
 */

// ---------------------------------------------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------------------------------------------

/** Order of a sort: ascending or descending. */
export type SortDirection = "asc" | "desc";

/** One declared value: a stable code for the URL and the application's final, localized label. */
export type ListQueryOption<V extends string = string> = {
  /** Stable code; it appears in the URL and in saved views. Never a translated text, never contains a comma. */
  readonly value: V;
  /** Final display text from the application's catalog. */
  readonly label: string;
};

/** One value a lookup loaded or resolved. */
export type LookupItem = {
  /** Stable ID; it appears in the URL. Never contains a comma. */
  readonly value: string;
  /** Final display text. */
  readonly label: string;
  /** Optional second line, such as an email address or a number. */
  readonly meta?: string;
};

/** What `load` of a lookup returns for one search. */
export type LookupLoadResult = {
  /** At most `limit` items, best match first. */
  readonly items: readonly LookupItem[];
  /** Optional number of matches per value, counted by the application with the other filters applied. */
  readonly counts?: Readonly<Record<string, number>>;
};

/** A number range; a missing end is open. At least one end is set, and `min` is never above `max`. */
export type NumberRange = { readonly min?: number; readonly max?: number };

/**
 * A period: either one declared preset code, or a custom range whose missing end is open.
 *
 * For `dateRange` fields the ends are calendar days (`YYYY-MM-DD`); for `timeRange` fields they are UTC minutes
 * (`YYYY-MM-DDTHH:MMZ`). A missing `to` means "until now", a missing `from` "since the beginning". At least one end
 * is set, and `from` is never after `to`. The application interprets days in its own time zone.
 */
export type PeriodValue<P extends string = string> =
  | { readonly kind: "preset"; readonly preset: P }
  | { readonly kind: "range"; readonly from?: string; readonly to?: string };

// ---------------------------------------------------------------------------------------------------------------
// Fields
// ---------------------------------------------------------------------------------------------------------------

type FieldCommon = {
  /** Final display text of the field, the start of its sentence ("Status is …"). */
  readonly label: string;
  /** Replaces the word "is" in the sentence when the field needs another verb. No other operators exist. */
  readonly op?: string;
  /** Shown first when someone adds a filter. */
  readonly common: boolean;
};

/** Fixed values declared in code; one or many may be chosen. URL: `status=open,closed`. */
export type ChoiceField<V extends string = string, M extends boolean = boolean, R = unknown> = FieldCommon & {
  readonly kind: "choice";
  readonly options: readonly ListQueryOption<V>[];
  /** `true`: any number of values (the default); `false`: exactly one. */
  readonly multiple: M;
  /** The application supplies a count per value; the UI shows it next to the value. */
  readonly counts: boolean;
  /** Makes the field mandatory: it is always active, cannot be removed, and resets to this value. */
  readonly required: R;
};

/** Values the application loads on demand, such as people or customers. URL: `consignor=c-1001,c-1002`. */
export type LookupField<M extends boolean = boolean, R = unknown> = FieldCommon & {
  readonly kind: "lookup";
  /** `true`: any number of values (the default); `false`: exactly one. */
  readonly multiple: M;
  /** Search for values. Abort when `signal` fires; return at most `limit` items. */
  readonly load: (query: string, context: { readonly signal: AbortSignal; readonly limit: number }) => Promise<LookupLoadResult>;
  /** Labels for chosen IDs, such as those from the URL. Runs during server rendering, so the first paint shows names. */
  readonly resolve: (values: readonly string[], context: { readonly signal: AbortSignal }) => Promise<readonly LookupItem[]>;
  /** Most items one search shows. Default 8, at most 50. */
  readonly limit: number;
  /** Characters before `load` runs. Default 0: an empty search shows frequent or recent values. */
  readonly minChars: number;
  readonly required: R;
};

/** A number from–to; either end may be open. URL: `price=500..2000`, `price=500..`, `price=..2000`. */
export type NumberRangeField<R = unknown> = FieldCommon & {
  readonly kind: "numberRange";
  /** Final unit text shown after numbers, such as "€" or "ms". */
  readonly unit?: string;
  /** Ranges offered for one click. */
  readonly presets: readonly NumberRange[];
  readonly required: R;
};

/**
 * Calendar days from–to, or a declared preset. URL: `received=last-30d`, `received=2026-11-01..2026-11-30`,
 * `received=2026-11-01..`.
 */
export type DateRangeField<P extends string = string, R = unknown> = FieldCommon & {
  readonly kind: "dateRange";
  readonly presets: readonly ListQueryOption<P>[];
  readonly required: R;
};

/**
 * Points in time from–to (UTC minutes), or a declared preset such as "last 15 minutes".
 * URL: `time=last-15m`, `time=2026-11-24T08:00Z..2026-11-24T09:30Z`.
 */
export type TimeRangeField<P extends string = string, R = unknown> = FieldCommon & {
  readonly kind: "timeRange";
  readonly presets: readonly ListQueryOption<P>[];
  /** Whether a custom from–to range is allowed beside the presets. Default `true`. */
  readonly custom: boolean;
  readonly required: R;
};

/** Yes or no. URL: `twofa=yes`, `twofa=no`. */
export type BoolField<R = unknown> = FieldCommon & {
  readonly kind: "bool";
  /** Final display texts of both values, such as "on" and "off". */
  readonly labels: { readonly yes: string; readonly no: string };
  readonly required: R;
};

/** Exactly one free text value, such as a request ID. URL: `request=7f3a9c`. */
export type TextField<R = unknown> = FieldCommon & {
  readonly kind: "text";
  readonly required: R;
};

/** Any declared filter field. */
export type ListQueryField =
  | ChoiceField<string, boolean, unknown>
  | LookupField<boolean, unknown>
  | NumberRangeField<unknown>
  | DateRangeField<string, unknown>
  | TimeRangeField<string, unknown>
  | BoolField<unknown>
  | TextField<unknown>;

/** The value type one field holds in the state. */
export type ListQueryFieldValue<F> =
  F extends ChoiceField<infer V, infer M, unknown>
    ? M extends false
      ? V
      : readonly V[]
    : F extends LookupField<infer M, unknown>
      ? M extends false
        ? string
        : readonly string[]
      : F extends NumberRangeField<unknown>
        ? NumberRange
        : F extends DateRangeField<infer P, unknown>
          ? PeriodValue<P>
          : F extends TimeRangeField<infer P, unknown>
            ? PeriodValue<P>
            : F extends BoolField<unknown>
              ? boolean
              : F extends TextField<unknown>
                ? string
                : never;

// A type parameter given explicitly must match the properties: `<..., false>` needs `multiple: false`, a mandatory
// type needs its `required` value. Inference reads both from the properties that are present.
type FieldSpec<R> = {
  readonly label: string;
  readonly op?: string;
  readonly common?: boolean;
} & ([R] extends [undefined]
  ? { readonly required?: undefined }
  : {
      /** Makes the field mandatory: always active, never removable, and reset to this value. Omitted from the URL. */
      readonly required: R;
    });

type MultipleSpec<M extends boolean> = [M] extends [false] ? { readonly multiple: false } : { readonly multiple?: M };

type ChoiceValue<V extends string, M extends boolean> = M extends false ? V : readonly V[];

/** Builders for the filter fields of {@link defineListQuery}. */
export const field = {
  /** Fixed values declared in code. `multiple: false` allows exactly one value. */
  choice<const V extends string, M extends boolean = true, const R extends ChoiceValue<NoInfer<V>, NoInfer<M>> | undefined = undefined>(
    spec: FieldSpec<R> & MultipleSpec<M> & { readonly options: readonly ListQueryOption<V>[]; readonly counts?: boolean },
  ): NoInfer<ChoiceField<V, M, R>> {
    return {
      kind: "choice",
      ...common(spec),
      options: spec.options,
      multiple: (spec.multiple ?? true) as M,
      counts: spec.counts ?? false,
      required: spec.required as R,
    };
  },
  /** Values loaded on demand. `resolve` names the chosen IDs for the first paint. */
  lookup<M extends boolean = true, const R extends (M extends false ? string : readonly string[]) | undefined = undefined>(
    spec: FieldSpec<R> &
      MultipleSpec<M> & {
        readonly load: LookupField["load"];
        readonly resolve: LookupField["resolve"];
        readonly limit?: number;
        readonly minChars?: number;
      },
  ): NoInfer<LookupField<M, R>> {
    return {
      kind: "lookup",
      ...common(spec),
      multiple: (spec.multiple ?? true) as M,
      load: spec.load,
      resolve: spec.resolve,
      limit: spec.limit ?? 8,
      minChars: spec.minChars ?? 0,
      required: spec.required as R,
    };
  },
  /** A number from–to with open ends. */
  numberRange<const R extends NumberRange | undefined = undefined>(
    spec: FieldSpec<R> & { readonly unit?: string; readonly presets?: readonly NumberRange[] },
  ): NoInfer<NumberRangeField<R>> {
    return { kind: "numberRange", ...common(spec), unit: spec.unit, presets: spec.presets ?? [], required: spec.required as R };
  },
  /** Calendar days from–to, or a declared preset. */
  dateRange<const P extends string = never, const R extends PeriodValue<NoInfer<P>> | undefined = undefined>(
    spec: FieldSpec<R> & { readonly presets?: readonly ListQueryOption<P>[] },
  ): NoInfer<DateRangeField<P, R>> {
    return { kind: "dateRange", ...common(spec), presets: spec.presets ?? [], required: spec.required as R };
  },
  /** Points in time (UTC minutes) from–to, or a declared preset. `custom: false` allows only the presets. */
  timeRange<const P extends string, const R extends PeriodValue<NoInfer<P>> | undefined = undefined>(
    spec: FieldSpec<R> & { readonly presets: readonly ListQueryOption<P>[]; readonly custom?: boolean },
  ): NoInfer<TimeRangeField<P, R>> {
    return { kind: "timeRange", ...common(spec), presets: spec.presets, custom: spec.custom ?? true, required: spec.required as R };
  },
  /** Yes or no, with the application's words for both. */
  bool<const R extends boolean | undefined = undefined>(
    spec: FieldSpec<R> & { readonly labels: { readonly yes: string; readonly no: string } },
  ): NoInfer<BoolField<R>> {
    return { kind: "bool", ...common(spec), labels: spec.labels, required: spec.required as R };
  },
  /** Exactly one free text value. */
  text<const R extends string | undefined = undefined>(spec: FieldSpec<R>): NoInfer<TextField<R>> {
    return { kind: "text", ...common(spec), required: spec.required as R };
  },
};

const common = (spec: { readonly label: string; readonly op?: string; readonly common?: boolean }): FieldCommon => ({
  label: spec.label,
  ...(spec.op === undefined ? {} : { op: spec.op }),
  common: spec.common ?? false,
});

// ---------------------------------------------------------------------------------------------------------------
// Declaration and state
// ---------------------------------------------------------------------------------------------------------------

/** One sort the person may choose. */
export type SortOption = {
  /** Final display text, such as "Price". */
  readonly label: string;
  /** Directions offered, the first one is used when the sort is picked. Default `["asc", "desc"]`. */
  readonly directions?: readonly SortDirection[];
};

/** The sort of the state. */
export type SortState<S extends string = string> = { readonly field: S; readonly direction: SortDirection };

/**
 * The sorts of a list: either options with a default, or one fixed order shown as text
 * (such as "newest first" in a log). A fixed sort has no URL parameter.
 */
export type SortDeclaration<S extends string = string> =
  | {
      readonly options: { readonly [K in S]: SortOption };
      readonly default: SortState<NoInfer<S>>;
      readonly fixed?: undefined;
    }
  | {
      readonly fixed: SortState<S> & { readonly label: string };
      readonly options?: undefined;
      readonly default?: undefined;
    };

/** One grouping the person may choose. */
export type GroupOption = {
  /** Final display text, such as "Location". */
  readonly label: string;
};

/** What {@link defineListQuery} takes. */
export type ListQueryDeclaration<
  F extends Record<string, ListQueryField> = Record<string, ListQueryField>,
  S extends string = string,
  G extends string = string,
> = {
  /** Stable key of the list; saved views belong to it. */
  readonly key: string;
  /** Filter fields in display and URL order. Keys are stable codes and become URL parameter names. */
  readonly fields: F;
  /** Free search as `q`; omit it when the list has none. */
  readonly search?: { readonly label: string };
  readonly sort: SortDeclaration<S>;
  /** Groupings as `group`; omit it when the list has none. No grouping is the default. */
  readonly group?: { readonly [K in G]: GroupOption };
  /** Other URL parameters the page owns beside the query, such as a selection or a page number. */
  readonly pageParams?: readonly string[];
};

type RequiredKeys<F> = {
  [K in keyof F]: F[K] extends { readonly required: infer R } ? (undefined extends R ? never : K) : never;
}[keyof F];

type Simplify<T> = { [K in keyof T]: T[K] } & {};

/** The active filters: mandatory fields always hold a value, the others only when they are active. */
export type ListQueryFilters<F> = Simplify<
  { readonly [K in RequiredKeys<F>]: ListQueryFieldValue<F[K]> } & {
    readonly [K in Exclude<keyof F, RequiredKeys<F>>]?: ListQueryFieldValue<F[K]>;
  }
>;

/** The full state of a list, typed from its declaration. Plain data: compare two states by their `serialize` output. */
export type ListQueryState<F = Record<string, ListQueryField>, S extends string = string, G extends string = string> = {
  readonly filters: ListQueryFilters<F>;
  /** The free search; absent when empty. */
  readonly search?: string;
  readonly sort: SortState<S>;
  /** The chosen grouping; absent means no grouping. */
  readonly group?: G;
  /** Key of the view the state started from; the application resolves it. */
  readonly view?: string;
};

/** Why `parse` dropped part of a URL. Stable codes; the application words them. */
export type ListQueryIssueCode =
  /** A parameter the query does not own and the page did not declare in `pageParams`. */
  | "unknown"
  /** A value the field, sort or group does not allow; for multiple values only the invalid ones are dropped. */
  | "invalid"
  /** A parameter given more than once; the first one counts. */
  | "duplicate"
  /** The query is longer than {@link LIST_QUERY_MAX_LENGTH}; it is dropped as a whole. */
  | "too_long";

/** One dropped part of a URL. `parse` never throws for URL input. */
export type ListQueryIssue = {
  readonly code: ListQueryIssueCode;
  /** The URL parameter name; empty for `too_long`, which concerns the whole query. */
  readonly param: string;
  /** The dropped raw value. */
  readonly value: string;
};

/** The result of `parse`: a valid state and every part that was dropped. */
export type ListQueryParseResult<State> = { readonly state: State; readonly issues: readonly ListQueryIssue[] };

/** A declared list query: its declaration plus URL and state helpers. */
export type ListQuery<
  F extends Record<string, ListQueryField> = Record<string, ListQueryField>,
  S extends string = string,
  G extends string = string,
> = ListQueryDeclaration<F, S, G> & {
  /** Reads a URL. Invalid and unknown parts are dropped and reported in `issues`, never thrown. */
  parse(params: URLSearchParams | string): ListQueryParseResult<ListQueryState<F, S, G>>;
  /**
   * Writes a state as URL parameters: `view`, the fields in declaration order, `q`, `sort`, `group`.
   * Its text keeps `,` `:` `/` and `@` readable (`status=open,sold`); everything else is encoded as usual.
   * Defaults and mandatory fields at their default are omitted, so equal states give equal URLs.
   * Parameters of `base` the query does not own come first and stay unchanged. Whatever `serialize` writes, `parse`
   * reads back to the same state. States from `parse`, `set`, `clear` and `reset` always fit; a state built by hand
   * that the URL cannot hold (an undeclared value, sort or group, a reversed range, a number with an exponent, more
   * than {@link LIST_QUERY_MAX_LENGTH} characters) throws a `RangeError`. Derive follow-up states with `set`.
   */
  serialize(state: ListQueryState<F, S, G>, base?: URLSearchParams | string): URLSearchParams;
  /**
   * The one safe way to a follow-up state: changes one filter, or the search (`"q"`), sort or grouping, and returns
   * the new state, or `undefined` when the value is not valid or the URL cannot hold the result (such as more than
   * {@link LIST_QUERY_MAX_LENGTH} characters). Never throws: offer no link or action for `undefined`. A filter keeps
   * its canonical form (declared value order, no duplicates); an empty value clears it, and an empty search removes it.
   */
  set<K extends ListQuerySetKey<F>>(
    state: ListQueryState<F, S, G>,
    key: K,
    value: ListQuerySetValue<F, S, G, K>,
  ): ListQueryState<F, S, G> | undefined;
  /** Removes one filter; a mandatory field returns to its default. */
  clear(state: ListQueryState<F, S, G>, key: keyof F & string): ListQueryState<F, S, G>;
  /** The default state: no filters but the mandatory ones, no search, the default sort, no grouping, no view. */
  reset(): ListQueryState<F, S, G>;
};

/** What `set` changes: a filter field, the search `"q"`, the `"sort"` or the `"group"`. */
export type ListQuerySetKey<F> = (keyof F & string) | "q" | "sort" | "group";

/** The value `set` takes for a key: the field's value, the search text, a sort, or a grouping (`undefined`: none). */
export type ListQuerySetValue<F, S extends string, G extends string, K> = K extends "q"
  ? string
  : K extends "sort"
    ? SortState<S>
    : K extends "group"
      ? G | undefined
      : K extends keyof F
        ? ListQueryFieldValue<F[K]>
        : never;

/** The state type of a declared query: `ListQueryStateOf<typeof articleQuery>`. */
export type ListQueryStateOf<Q> = Q extends ListQuery<infer F, infer S, infer G> ? ListQueryState<F, S, G> : never;

// ---------------------------------------------------------------------------------------------------------------
// Saved views
// ---------------------------------------------------------------------------------------------------------------

/** A named view. `query` is the output of `serialize(...).toString()`, without `view`. */
export type SavedListView = {
  /** Stable key, used as `view=` in the URL: letters, digits, `.`, `_` and `-`, at most 64 characters. */
  readonly key: string;
  /** Name the person or application gave the view. */
  readonly label: string;
  /** The serialized query of the view. */
  readonly query: string;
};

/**
 * Where an application keeps saved views. `@k2b/ui` supplies only this type and the UI; the application implements
 * it in a cookie, in its own table per person or for everyone, or not at all. The server checks every write.
 */
export type ViewStore = {
  /** Tells the UI which words and symbol apply: this device, this person, or everyone using the app. */
  readonly scope: "device" | "person" | "app";
  /** Whether the current person may save here; the server decided it for this person. */
  readonly writable: boolean;
  /** The views of this list, in display order. */
  list(signal?: AbortSignal): Promise<readonly SavedListView[]>;
  /** Saves a new view, or replaces the view with the given `key`. Rejects with a final message when it does not fit. */
  save(view: { readonly key?: string; readonly label: string; readonly query: string }): Promise<SavedListView>;
  /** Removes one view. */
  remove(key: string): Promise<void>;
};

// ---------------------------------------------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------------------------------------------

/** Longest query `parse` accepts, in characters of the owned parameters: the link length that passes on safely. */
export const LIST_QUERY_MAX_LENGTH = 2000;

const RESERVED = new Set(["view", "q", "sort", "group"]);
const NAME = /^[A-Za-z][A-Za-z0-9-]*$/;
const VIEW_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const MINUTE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})Z$/;
/** The one number grammar of the URL: no exponent, no leading zeros, no plus sign. */
const NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;
const DIRECTIONS: readonly SortDirection[] = ["asc", "desc"];

type Decoded = { readonly value?: unknown; readonly invalid: readonly string[] };

/**
 * The parameters `serialize` returns. Their text keeps `,` `:` `/` and `@` readable (`level=warn,error`,
 * `time=2026-11-24T08:00Z..`): a URL query allows them unencoded, and form decoding reads them unchanged. Every other
 * character stays encoded as `URLSearchParams` does, so `&`, `=`, `+`, `#` and `%` keep their meaning. Each `%`
 * of the encoded text starts one escape, so only real escapes of those four characters are turned back.
 */
class ListQueryParams extends URLSearchParams {
  override toString(): string {
    return super.toString().replace(/%(?:2C|3A|2F|40)/gi, (escape) => decodeURIComponent(escape));
  }
}

const own = <T>(record: Readonly<Record<string, T>>, key: string): T | undefined => (Object.hasOwn(record, key) ? record[key] : undefined);

const validDay = (text: string): boolean => {
  const match = DAY.exec(text);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  // setUTCFullYear keeps the years 0000–0099, which Date.UTC would move into the 1900s.
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
};

const validMinute = (text: string): boolean => {
  const match = MINUTE.exec(text);
  if (!match) return false;
  return validDay(text.slice(0, 10)) && Number(match[4]) < 24 && Number(match[5]) < 60;
};

/** A number in the URL grammar whose own text is in the grammar again, so it round-trips; `undefined` otherwise. */
const decodeNumber = (text: string): number | undefined => {
  if (!NUMBER.test(text)) return undefined;
  const value = Number(text);
  if (!Number.isFinite(value) || !NUMBER.test(String(value))) return undefined;
  return value === 0 ? 0 : value;
};

/** The URL text of a number, or `null` when the URL grammar cannot hold it (not finite, or an exponent). */
const encodeNumber = (value: unknown): string | null => {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const text = String(value === 0 ? 0 : value);
  return NUMBER.test(text) ? text : null;
};

const splitRange = (raw: string): readonly [string, string] | undefined => {
  const parts = raw.split("..");
  return parts.length === 2 && parts[0] !== undefined && parts[1] !== undefined ? [parts[0], parts[1]] : undefined;
};

const decodePeriod = (raw: string, presets: readonly ListQueryOption[], custom: boolean, valid: (text: string) => boolean): Decoded => {
  if (presets.some((preset) => preset.value === raw)) return { value: { kind: "preset", preset: raw }, invalid: [] };
  const range = custom ? splitRange(raw) : undefined;
  if (!range) return { invalid: [raw] };
  const [from, to] = range;
  if ((from === "" && to === "") || (from !== "" && !valid(from)) || (to !== "" && !valid(to))) return { invalid: [raw] };
  if (from !== "" && to !== "" && from > to) return { invalid: [raw] };
  return { value: { kind: "range", ...(from === "" ? {} : { from }), ...(to === "" ? {} : { to }) }, invalid: [] };
};

const decodeList = (raw: string, accept: (part: string) => boolean, multiple: boolean, order?: readonly string[]): Decoded => {
  const chosen: string[] = [];
  const invalid: string[] = [];
  for (const part of raw.split(",")) {
    if (part === "") continue;
    if (!accept(part)) invalid.push(part);
    else if (!chosen.includes(part)) chosen.push(part);
  }
  if (!multiple) {
    if (chosen.length !== 1) return { invalid: chosen.length === 0 ? invalid : [raw] };
    return { value: chosen[0], invalid };
  }
  if (order) chosen.sort((left, right) => order.indexOf(left) - order.indexOf(right));
  return chosen.length === 0 ? { invalid } : { value: chosen, invalid };
};

const decode = (definition: ListQueryField, raw: string): Decoded => {
  switch (definition.kind) {
    case "choice": {
      const order = definition.options.map((option) => option.value);
      return decodeList(raw, (part) => order.includes(part), definition.multiple, order);
    }
    case "lookup":
      return decodeList(raw, () => true, definition.multiple);
    case "numberRange": {
      const range = splitRange(raw);
      if (!range) return { invalid: [raw] };
      const [min, max] = [range[0] === "" ? undefined : decodeNumber(range[0]), range[1] === "" ? undefined : decodeNumber(range[1])];
      if ((range[0] === "" && range[1] === "") || (range[0] !== "" && min === undefined) || (range[1] !== "" && max === undefined)) {
        return { invalid: [raw] };
      }
      if (min !== undefined && max !== undefined && min > max) return { invalid: [raw] };
      return { value: { ...(min === undefined ? {} : { min }), ...(max === undefined ? {} : { max }) }, invalid: [] };
    }
    case "dateRange":
      return decodePeriod(raw, definition.presets, true, validDay);
    case "timeRange":
      return decodePeriod(raw, definition.presets, definition.custom, validMinute);
    case "bool":
      return raw === "yes" ? { value: true, invalid: [] } : raw === "no" ? { value: false, invalid: [] } : { invalid: [raw] };
    case "text":
      return { value: raw, invalid: [] };
  }
};

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === "object" && value !== null;

/** One code of a list value, or `null` when it cannot stand between commas. */
const listPart = (part: unknown): string | null => (typeof part === "string" && part !== "" && !part.includes(",") ? part : null);

/**
 * The URL text of a state value without dropping anything: `undefined` when the value is empty (the filter is
 * inactive), `null` when the URL cannot hold it. `decode` then decides whether the text is valid.
 */
const encode = (definition: ListQueryField, value: unknown): string | undefined | null => {
  if (value === undefined) return undefined;
  switch (definition.kind) {
    case "choice":
    case "lookup": {
      if (!definition.multiple) return value === "" ? undefined : listPart(value);
      if (!Array.isArray(value)) return null;
      if (value.length === 0) return undefined;
      const parts = value.map(listPart);
      return parts.every((part) => part !== null) ? parts.join(",") : null;
    }
    case "numberRange": {
      if (!isRecord(value)) return null;
      if (value.min === undefined && value.max === undefined) return undefined;
      const min = value.min === undefined ? "" : encodeNumber(value.min);
      const max = value.max === undefined ? "" : encodeNumber(value.max);
      return min === null || max === null ? null : `${min}..${max}`;
    }
    case "dateRange":
    case "timeRange": {
      if (!isRecord(value)) return null;
      if (value.kind === "preset") return typeof value.preset === "string" && value.preset !== "" ? value.preset : null;
      if (value.kind !== "range") return null;
      if (value.from === undefined && value.to === undefined) return undefined;
      const [from, to] = [value.from ?? "", value.to ?? ""];
      return typeof from === "string" && typeof to === "string" ? `${from}..${to}` : null;
    }
    case "bool":
      return value === true ? "yes" : value === false ? "no" : null;
    case "text":
      return value === "" ? undefined : typeof value === "string" ? value : null;
  }
};

type Checked = { readonly raw: string; readonly value: unknown } | "empty" | "invalid";

/** Checks a state value against the URL: its text, and the canonical value `parse` reads from that text. */
const check = (definition: ListQueryField, value: unknown): Checked => {
  const raw = encode(definition, value);
  if (raw === undefined) return "empty";
  if (raw === null) return "invalid";
  const decoded = decode(definition, raw);
  if (decoded.invalid.length > 0 || decoded.value === undefined) return "invalid";
  // The canonical text: declared value order, no duplicates, the shortest number form.
  const canonical = encode(definition, decoded.value);
  return typeof canonical === "string" ? { raw: canonical, value: decoded.value } : "invalid";
};

const assertCode = (code: string, what: string): void => {
  if (code === "" || code.includes(",")) throw new Error(`defineListQuery: ${what} "${code}" must be non-empty and contain no comma`);
};

/** Checks a declaration and returns the checked defaults of its mandatory fields. */
const checkDeclaration = (declaration: ListQueryDeclaration): ReadonlyMap<string, { readonly raw: string; readonly value: unknown }> => {
  const pageParams = new Set(declaration.pageParams ?? []);
  const defaults = new Map<string, { readonly raw: string; readonly value: unknown }>();
  for (const [key, definition] of Object.entries(declaration.fields)) {
    // Keys of Object.prototype would read as inherited values from the state's filters.
    if (!NAME.test(key) || RESERVED.has(key) || key in Object.prototype) {
      throw new Error(`defineListQuery: field key "${key}" is reserved or not a stable code`);
    }
    if (pageParams.has(key)) throw new Error(`defineListQuery: "${key}" is both a field and a page parameter`);
    if (definition.kind === "choice") for (const option of definition.options) assertCode(option.value, `value of ${key}`);
    if (definition.kind === "dateRange" || definition.kind === "timeRange") {
      for (const preset of definition.presets) {
        assertCode(preset.value, `preset of ${key}`);
        if (preset.value.includes("..")) throw new Error(`defineListQuery: preset "${preset.value}" of ${key} must not contain ".."`);
      }
    }
    if (definition.kind === "lookup" && (definition.limit < 1 || definition.limit > 50)) {
      throw new Error(`defineListQuery: limit of ${key} must be between 1 and 50`);
    }
    if (definition.required !== undefined) {
      const checked = check(definition, definition.required);
      if (typeof checked === "string") throw new Error(`defineListQuery: required value of ${key} is not valid`);
      defaults.set(key, checked);
    }
  }
  for (const name of pageParams) {
    if (RESERVED.has(name)) throw new Error(`defineListQuery: page parameter "${name}" is reserved`);
  }
  const sort = declaration.sort;
  if (sort.fixed === undefined) {
    const option = own<SortOption>(sort.options, sort.default.field);
    if (!option || !(option.directions ?? DIRECTIONS).includes(sort.default.direction)) {
      throw new Error(`defineListQuery: default sort "${sort.default.field}.${sort.default.direction}" is not an option`);
    }
    for (const key of Object.keys(sort.options)) {
      if (!NAME.test(key)) throw new Error(`defineListQuery: sort key "${key}" is not a stable code`);
    }
  }
  for (const key of Object.keys(declaration.group ?? {})) {
    if (!NAME.test(key)) throw new Error(`defineListQuery: group key "${key}" is not a stable code`);
  }
  return defaults;
};

/**
 * Declares the filters, sorts and groups of one list. Throws only for a wrong declaration (a programming error),
 * never for URL input.
 */
export function defineListQuery<const F extends Record<string, ListQueryField>, const S extends string, const G extends string = never>(
  declaration: ListQueryDeclaration<F, S, G>,
): ListQuery<F, S, G> {
  const defaults = checkDeclaration(declaration);
  type State = ListQueryState<F, S, G>;
  const fields: readonly (readonly [string, ListQueryField])[] = Object.entries(declaration.fields);
  const owned = new Set<string>(["view", ...fields.map(([key]) => key), "q", "sort", "group"]);
  const pageParams = new Set(declaration.pageParams ?? []);
  const sortDeclaration: SortDeclaration<string> = declaration.sort;
  const sortOptions: Readonly<Record<string, SortOption>> = sortDeclaration.options ?? {};
  const groups: Readonly<Record<string, GroupOption>> = declaration.group ?? {};
  const defaultSort: SortState<string> = sortDeclaration.fixed
    ? { field: sortDeclaration.fixed.field, direction: sortDeclaration.fixed.direction }
    : sortDeclaration.default;

  const requiredFilters = (): Record<string, unknown> => {
    const filters: Record<string, unknown> = {};
    for (const [key, checked] of defaults) filters[key] = checked.value;
    return filters;
  };

  // The state is built from checked values; the declaration's types describe exactly these shapes.
  const asState = (state: {
    filters: Record<string, unknown>;
    search?: string;
    sort: SortState<string>;
    group?: string;
    view?: string;
  }): State => state as unknown as State;

  const reset = (): State => asState({ filters: requiredFilters(), sort: defaultSort });

  const ownedLength = (params: URLSearchParams): number =>
    new URLSearchParams([...params].filter(([name]) => owned.has(name))).toString().length;

  const parse = (input: URLSearchParams | string): ListQueryParseResult<State> => {
    const params = typeof input === "string" ? new URLSearchParams(input) : input;
    const issues: ListQueryIssue[] = [];
    const length = ownedLength(params);
    if (length > LIST_QUERY_MAX_LENGTH) {
      return { state: reset(), issues: [{ code: "too_long", param: "", value: `${length}` }] };
    }
    const first = new Map<string, string>();
    for (const [name, value] of params) {
      if (name.startsWith("_") || pageParams.has(name)) continue;
      if (!owned.has(name)) issues.push({ code: "unknown", param: name, value });
      else if (first.has(name)) issues.push({ code: "duplicate", param: name, value });
      else first.set(name, value);
    }
    const filters = requiredFilters();
    for (const [key, definition] of fields) {
      const raw = first.get(key);
      if (raw === undefined || raw === "") continue;
      const decoded = decode(definition, raw);
      for (const value of decoded.invalid) issues.push({ code: "invalid", param: key, value });
      if (decoded.value !== undefined) filters[key] = decoded.value;
    }
    const state: { filters: Record<string, unknown>; search?: string; sort: SortState<string>; group?: string; view?: string } = {
      filters,
      sort: defaultSort,
    };
    const search = first.get("q");
    if (search !== undefined && search !== "") {
      if (declaration.search) state.search = search;
      else issues.push({ code: "unknown", param: "q", value: search });
    }
    const sort = first.get("sort");
    if (sort !== undefined && sort !== "") {
      const dot = sort.lastIndexOf(".");
      const sortField = sort.slice(0, dot);
      const direction = sort.slice(dot + 1);
      // The sort options are the server's whitelist: only own keys count, never inherited ones such as `constructor`.
      const option = sortDeclaration.fixed ? undefined : own(sortOptions, sortField);
      const match = (option?.directions ?? (option ? DIRECTIONS : [])).find((candidate) => candidate === direction);
      if (dot > 0 && match) state.sort = { field: sortField, direction: match };
      else issues.push({ code: "invalid", param: "sort", value: sort });
    }
    const group = first.get("group");
    if (group !== undefined && group !== "") {
      if (Object.hasOwn(groups, group)) state.group = group;
      else issues.push({ code: "invalid", param: "group", value: group });
    }
    const view = first.get("view");
    if (view !== undefined && view !== "") {
      if (VIEW_KEY.test(view)) state.view = view;
      else issues.push({ code: "invalid", param: "view", value: view });
    }
    return { state: asState(state), issues };
  };

  /** The URL parameters of a state, or the reason the URL cannot hold it. Never throws. */
  const write = (state: State, base?: URLSearchParams | string): URLSearchParams | RangeError => {
    const params = new ListQueryParams();
    for (const [name, value] of new URLSearchParams(base ?? "")) if (!owned.has(name)) params.append(name, value);
    if (state.view !== undefined && state.view !== "") {
      if (!VIEW_KEY.test(state.view)) return new RangeError(`serialize: view "${state.view}" is not a view key`);
      params.set("view", state.view);
    }
    const filters: Readonly<Record<string, unknown>> = state.filters;
    for (const [key, definition] of fields) {
      const checked = check(definition, own(filters, key));
      if (checked === "empty") continue;
      if (checked === "invalid") return new RangeError(`serialize: the URL cannot hold the value of "${key}"`);
      if (checked.raw !== defaults.get(key)?.raw) params.set(key, checked.raw);
    }
    if (declaration.search && state.search) params.set("q", state.search);
    if (state.sort.field !== defaultSort.field || state.sort.direction !== defaultSort.direction) {
      const option = sortDeclaration.fixed ? undefined : own(sortOptions, state.sort.field);
      if (!option || !(option.directions ?? DIRECTIONS).includes(state.sort.direction)) {
        return new RangeError(`serialize: sort "${state.sort.field}.${state.sort.direction}" is not an option`);
      }
      params.set("sort", `${state.sort.field}.${state.sort.direction}`);
    }
    if (state.group !== undefined) {
      if (!Object.hasOwn(groups, state.group)) return new RangeError(`serialize: group "${state.group}" is not an option`);
      params.set("group", state.group);
    }
    const length = ownedLength(params);
    if (length > LIST_QUERY_MAX_LENGTH) {
      return new RangeError(`serialize: the query has ${length} characters, more than ${LIST_QUERY_MAX_LENGTH}`);
    }
    return params;
  };

  const serialize = (state: State, base?: URLSearchParams | string): URLSearchParams => {
    const written = write(state, base);
    if (written instanceof RangeError) throw written;
    return written;
  };

  /** The follow-up state with one part changed, or `undefined` when the value is not valid or the URL cannot hold it. */
  const change = (state: State, key: string, value: unknown): State | undefined => {
    const { filters: before, ...rest } = state;
    const filters: Record<string, unknown> = { ...before };
    const next: { filters: Record<string, unknown>; search?: string; sort: SortState<string>; group?: string; view?: string } = {
      ...rest,
      filters,
    };
    if (key === "q") {
      if (typeof value !== "string" || (!declaration.search && value !== "")) return undefined;
      if (value === "") delete next.search;
      else next.search = value;
    } else if (key === "sort") {
      if (!isRecord(value) || typeof value.field !== "string" || (value.direction !== "asc" && value.direction !== "desc"))
        return undefined;
      next.sort = { field: value.field, direction: value.direction };
    } else if (key === "group") {
      if (value === undefined) delete next.group;
      else if (typeof value === "string") next.group = value;
      else return undefined;
    } else {
      const definition = own<ListQueryField>(declaration.fields, key);
      if (!definition) return undefined;
      const checked = check(definition, value);
      if (checked === "invalid") return undefined;
      const stored = checked === "empty" ? defaults.get(key)?.value : checked.value;
      if (stored === undefined) delete filters[key];
      else filters[key] = stored;
    }
    const result = asState(next);
    return write(result) instanceof RangeError ? undefined : result;
  };

  const clear = (state: State, key: keyof F & string): State => {
    const filters: Record<string, unknown> = { ...state.filters };
    const value = defaults.get(key)?.value;
    if (value === undefined) delete filters[key];
    else filters[key] = value;
    return asState({ ...state, filters });
  };

  return { ...declaration, parse, serialize, set: change, clear, reset };
}
