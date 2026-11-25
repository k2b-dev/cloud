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

type FieldSpec<R> = {
  readonly label: string;
  readonly op?: string;
  readonly common?: boolean;
  /** Makes the field mandatory: always active, never removable, and reset to this value. Omitted from the URL. */
  readonly required?: R;
};

type ChoiceValue<V extends string, M extends boolean> = M extends false ? V : readonly V[];

/** Builders for the filter fields of {@link defineListQuery}. */
export const field = {
  /** Fixed values declared in code. `multiple: false` allows exactly one value. */
  choice<const V extends string, M extends boolean = true, const R extends ChoiceValue<NoInfer<V>, NoInfer<M>> | undefined = undefined>(
    spec: FieldSpec<R> & { readonly options: readonly ListQueryOption<V>[]; readonly multiple?: M; readonly counts?: boolean },
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
    spec: FieldSpec<R> & {
      readonly multiple?: M;
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

const common = (spec: FieldSpec<unknown>): FieldCommon => ({
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
   * Defaults and mandatory fields at their default are omitted, so equal states give equal URLs.
   * Parameters of `base` the query does not own come first and stay unchanged.
   */
  serialize(state: ListQueryState<F, S, G>, base?: URLSearchParams | string): URLSearchParams;
  /** Sets one filter. Setting an empty multiple value clears it. */
  set<K extends keyof F & string>(state: ListQueryState<F, S, G>, key: K, value: ListQueryFieldValue<F[K]>): ListQueryState<F, S, G>;
  /** Removes one filter; a mandatory field returns to its default. */
  clear(state: ListQueryState<F, S, G>, key: keyof F & string): ListQueryState<F, S, G>;
  /** The default state: no filters but the mandatory ones, no search, the default sort, no grouping, no view. */
  reset(): ListQueryState<F, S, G>;
};

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
const NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;
const DIRECTIONS: readonly SortDirection[] = ["asc", "desc"];

type Decoded = { readonly value?: unknown; readonly invalid: readonly string[] };

const validDay = (text: string): boolean => {
  const match = DAY.exec(text);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
};

const validMinute = (text: string): boolean => {
  const match = MINUTE.exec(text);
  if (!match) return false;
  return validDay(text.slice(0, 10)) && Number(match[4]) < 24 && Number(match[5]) < 60;
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
      const [min, max] = range;
      if ((min === "" && max === "") || (min !== "" && !NUMBER.test(min)) || (max !== "" && !NUMBER.test(max))) return { invalid: [raw] };
      if (min !== "" && max !== "" && Number(min) > Number(max)) return { invalid: [raw] };
      return { value: { ...(min === "" ? {} : { min: Number(min) }), ...(max === "" ? {} : { max: Number(max) }) }, invalid: [] };
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

const encodePeriod = (value: PeriodValue): string | undefined => {
  if (value.kind === "preset") return value.preset;
  return value.from === undefined && value.to === undefined ? undefined : `${value.from ?? ""}..${value.to ?? ""}`;
};

/** The URL text of a value, or `undefined` when the value is empty and the filter is inactive. */
const encode = (definition: ListQueryField, value: unknown): string | undefined => {
  switch (definition.kind) {
    case "choice": {
      if (!definition.multiple) return typeof value === "string" && value !== "" ? value : undefined;
      if (!Array.isArray(value)) return undefined;
      const chosen = definition.options.map((option) => option.value).filter((code) => value.includes(code));
      return chosen.length === 0 ? undefined : chosen.join(",");
    }
    case "lookup": {
      if (!definition.multiple) return typeof value === "string" && value !== "" ? value : undefined;
      if (!Array.isArray(value)) return undefined;
      const chosen = [...new Set(value.filter((part): part is string => typeof part === "string" && part !== ""))];
      return chosen.length === 0 ? undefined : chosen.join(",");
    }
    case "numberRange": {
      const range = value as NumberRange;
      if (range.min === undefined && range.max === undefined) return undefined;
      return `${range.min ?? ""}..${range.max ?? ""}`;
    }
    case "dateRange":
    case "timeRange":
      return encodePeriod(value as PeriodValue);
    case "bool":
      return value === true ? "yes" : value === false ? "no" : undefined;
    case "text":
      return typeof value === "string" && value !== "" ? value : undefined;
  }
};

const assertCode = (code: string, what: string): void => {
  if (code === "" || code.includes(",")) throw new Error(`defineListQuery: ${what} "${code}" must be non-empty and contain no comma`);
};

const assertDeclaration = (declaration: ListQueryDeclaration): void => {
  const pageParams = new Set(declaration.pageParams ?? []);
  for (const [key, definition] of Object.entries(declaration.fields)) {
    if (!NAME.test(key) || RESERVED.has(key)) throw new Error(`defineListQuery: field key "${key}" is reserved or not a stable code`);
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
      const raw = encode(definition, definition.required);
      if (raw === undefined || decode(definition, raw).value === undefined)
        throw new Error(`defineListQuery: required value of ${key} is not valid`);
    }
  }
  for (const name of pageParams) {
    if (RESERVED.has(name)) throw new Error(`defineListQuery: page parameter "${name}" is reserved`);
  }
  const sort = declaration.sort;
  if (sort.fixed === undefined) {
    const option: SortOption | undefined = sort.options[sort.default.field];
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
};

const sameText = (definition: ListQueryField, left: unknown, right: unknown): boolean =>
  encode(definition, left) === encode(definition, right);

/**
 * Declares the filters, sorts and groups of one list. Throws only for a wrong declaration (a programming error),
 * never for URL input.
 */
export function defineListQuery<const F extends Record<string, ListQueryField>, const S extends string, const G extends string = never>(
  declaration: ListQueryDeclaration<F, S, G>,
): ListQuery<F, S, G> {
  assertDeclaration(declaration);
  type State = ListQueryState<F, S, G>;
  const fields: readonly (readonly [string, ListQueryField])[] = Object.entries(declaration.fields);
  const owned = new Set<string>(["view", ...fields.map(([key]) => key), "q", "sort", "group"]);
  const pageParams = new Set(declaration.pageParams ?? []);
  const sortDeclaration: SortDeclaration<string> = declaration.sort;
  const groups: Readonly<Record<string, GroupOption>> = declaration.group ?? {};
  const defaultSort: SortState<string> = sortDeclaration.fixed
    ? { field: sortDeclaration.fixed.field, direction: sortDeclaration.fixed.direction }
    : sortDeclaration.default;

  const requiredFilters = (): Record<string, unknown> => {
    const filters: Record<string, unknown> = {};
    for (const [key, definition] of fields) if (definition.required !== undefined) filters[key] = definition.required;
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

  const parse = (input: URLSearchParams | string): ListQueryParseResult<State> => {
    const params = typeof input === "string" ? new URLSearchParams(input) : input;
    const issues: ListQueryIssue[] = [];
    const ownedEntries = [...params].filter(([name]) => owned.has(name));
    const length = new URLSearchParams(ownedEntries).toString().length;
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
      const option = sortDeclaration.fixed ? undefined : (sortDeclaration.options as Readonly<Record<string, SortOption>>)[sortField];
      const allowed = option ? (option.directions ?? DIRECTIONS) : [];
      const match = allowed.find((candidate) => candidate === direction);
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

  const serialize = (state: State, base?: URLSearchParams | string): URLSearchParams => {
    const params = new URLSearchParams();
    for (const [name, value] of new URLSearchParams(base ?? "")) if (!owned.has(name)) params.append(name, value);
    if (state.view) params.set("view", state.view);
    const filters: Readonly<Record<string, unknown>> = state.filters;
    for (const [key, definition] of fields) {
      const value = filters[key];
      if (value === undefined) continue;
      if (definition.required !== undefined && sameText(definition, value, definition.required)) continue;
      const raw = encode(definition, value);
      if (raw !== undefined) params.set(key, raw);
    }
    if (declaration.search && state.search) params.set("q", state.search);
    if (!sortDeclaration.fixed && (state.sort.field !== defaultSort.field || state.sort.direction !== defaultSort.direction)) {
      params.set("sort", `${state.sort.field}.${state.sort.direction}`);
    }
    if (state.group !== undefined) params.set("group", state.group);
    return params;
  };

  const withFilters = (state: State, filters: Record<string, unknown>): State => asState({ ...state, filters });

  const set = <K extends keyof F & string>(state: State, key: K, value: ListQueryFieldValue<F[K]>): State => {
    const definition = declaration.fields[key];
    const filters: Record<string, unknown> = { ...state.filters };
    if (definition && encode(definition, value) === undefined) {
      if (definition.required !== undefined) filters[key] = definition.required;
      else delete filters[key];
    } else filters[key] = value;
    return withFilters(state, filters);
  };

  const clear = (state: State, key: keyof F & string): State => {
    const definition = declaration.fields[key];
    const filters: Record<string, unknown> = { ...state.filters };
    if (definition?.required !== undefined) filters[key] = definition.required;
    else delete filters[key];
    return withFilters(state, filters);
  };

  return { ...declaration, parse, serialize, set, clear, reset };
}
