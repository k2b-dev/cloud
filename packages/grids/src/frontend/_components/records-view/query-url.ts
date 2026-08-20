/**
 * URL ↔ records-area state serialization. Single source of truth for
 * what's encoded in the URL — used by both the SSR initial render
 * (parses incoming search params) and the client RecordsView island
 * (writes via history.replaceState / pushState, reads via popstate).
 *
 * Designed to be tolerant: malformed JSON in any param falls back to
 * the empty fragment for that field rather than throwing. A stale
 * URL doesn't lock the user out of their data.
 *
 * URL shape (path-based, mirrors notebooks; query params are reserved
 * for UI state on top of the resource identified by the path):
 *
 *   /app/grids/<base>/table/<table>                 — records page
 *   /app/grids/<base>/table/<table>/view/<view>     — saved-view page
 *
 *   ?filter=<FilterTree JSON>
 *   ?meta=<RecordMetaQuery JSON>
 *   ?sort=<SortSpec[] JSON>
 *   ?groupBy=<GroupBySpec[] JSON>
 *   ?groupSort=<GroupSortSpec[] JSON>
 *   ?aggregations=<AggregationSpec[] JSON>
 *   ?columns=<ColumnSpec[] JSON>            — ad-hoc computed/view columns
 *   ?cursor=<JSON-encoded keyset cursor token>
 *   ?record=<public record ID — selected detail-panel record>
 *   ?trash=1                                — trash mode
 *   ?q=<text>&qFields=<csv public field IDs> — free-text search
 *   ?cv=<day|week|month|year>&cd=<YYYY-MM-DD> — calendar state
 *   ?cardSize=<small|medium|large>          — card view density
 *
 * Note: `table` / `view` are not query params — they live
 * in the path.
 */

import { ColumnSpecSchema, type RecordQuery } from "../../../contracts";

/**
 * URL-owned subset of RecordQuery. The full RecordQuery additionally
 * includes `limit` and `search` — `limit` is saved-view metadata only,
 * `search` lives on the sibling `search` field. `columns` is URL state
 * only for ad-hoc column overrides, mainly in-place computed columns.
 * Narrowing the type makes the round-trip `parse(build(s)) === s`
 * actually hold for every well-formed state.
 */
type RecordsUrlQuery = Pick<
  RecordQuery,
  "filter" | "recordMeta" | "sort" | "groupBy" | "groupSort" | "aggregations" | "columns" | "includeDeleted" | "deletedOnly"
>;

export type RecordsState = {
  query: RecordsUrlQuery;
  cursor: string | null;
  selectedRecordId: string | null;
  /** Free-text search params — kept separate from the URL-owned query
   *  subset, then folded into `query.search` for the server-side SQL
   *  search compiler. */
  search: { q: string; fieldIds: string[]; override?: boolean };
  calendar: { view: "day" | "week" | "month" | "year"; date: string };
  cardSize: CardSize;
};

export type CardSize = "small" | "medium" | "large";
const DEFAULT_CARD_SIZE: CardSize = "medium";

const tryParseJson = <T>(raw: string | null | undefined): T | null => {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
};

/** Tolerant typed-array parser — keeps only entries with the required keys. */
const tryParseArray = <T extends Record<string, unknown>>(raw: string | null | undefined, required: ReadonlyArray<keyof T>): T[] => {
  const parsed = tryParseJson<unknown>(raw);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((x): x is T => typeof x === "object" && x !== null && required.every((k) => k in (x as object)));
};

const entryOf = <K extends string, V>(key: K, value: V | undefined): Array<[K, V]> => (value === undefined ? [] : [[key, value]]);

const nonEmptyArray = <T>(items: T[]): T[] | undefined => (items.length > 0 ? items : undefined);
const isDirection = (value: unknown): value is "asc" | "desc" => value === "asc" || value === "desc";

const parseFilterParam = (params: URLSearchParams): RecordQuery["filter"] | undefined =>
  tryParseJson<RecordQuery["filter"]>(params.get("filter")) ?? undefined;

const parseRecordMetaParam = (params: URLSearchParams): RecordsUrlQuery["recordMeta"] | undefined => {
  const parsed = tryParseJson<unknown>(params.get("meta"));
  if (!parsed || typeof parsed !== "object") return undefined;
  const finalizationStates = Array.isArray((parsed as { finalizationStates?: unknown }).finalizationStates)
    ? (parsed as { finalizationStates: unknown[] }).finalizationStates.filter(
        (state): state is "draft" | "awaitingReview" | "finalized" =>
          state === "draft" || state === "awaitingReview" || state === "finalized",
      )
    : [];
  const users = (parsed as { users?: unknown }).users;
  const out: NonNullable<RecordsUrlQuery["recordMeta"]>["users"] = {};
  if (users && typeof users === "object") {
    for (const key of ["createdBy", "updatedBy", "deletedBy"] as const) {
      const ids = (users as Record<string, unknown>)[key];
      if (Array.isArray(ids)) {
        const clean = ids.filter((id): id is string => typeof id === "string");
        if (clean.length > 0) out[key] = clean;
      }
    }
  }
  return finalizationStates.length || Object.keys(out).length > 0
    ? { ...(finalizationStates.length ? { finalizationStates } : {}), ...(Object.keys(out).length > 0 ? { users: out } : {}) }
    : undefined;
};

const parseSortParam = (params: URLSearchParams): RecordsUrlQuery["sort"] | undefined => {
  const parsed = tryParseJson<unknown>(params.get("sort"));
  if (!Array.isArray(parsed)) return undefined;
  const rows: NonNullable<RecordsUrlQuery["sort"]> = [];
  for (const raw of parsed) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    if (!isDirection(item.direction)) continue;
    if (item.source === "record" && typeof item.key === "string") {
      if (!["createdAt", "updatedAt", "deletedAt"].includes(item.key)) continue;
      rows.push({ source: "record", key: item.key as "createdAt" | "updatedAt" | "deletedAt", direction: item.direction });
      continue;
    }
    if (typeof item.fieldId === "string") {
      rows.push({ ...(item.source === "field" ? { source: "field" as const } : {}), fieldId: item.fieldId, direction: item.direction });
    }
  }
  return nonEmptyArray(rows);
};

const parseGroupByParam = (params: URLSearchParams): RecordsUrlQuery["groupBy"] | undefined =>
  nonEmptyArray(tryParseArray<{ fieldId: string }>(params.get("groupBy"), ["fieldId"])) as RecordsUrlQuery["groupBy"] | undefined;

const parseGroupSortParam = (params: URLSearchParams): RecordsUrlQuery["groupSort"] | undefined =>
  nonEmptyArray(tryParseArray<{ fieldId: string; agg: string; direction?: "asc" | "desc" }>(params.get("groupSort"), ["fieldId", "agg"])) as
    | RecordsUrlQuery["groupSort"]
    | undefined;

const parseAggregationsParam = (params: URLSearchParams): RecordsUrlQuery["aggregations"] | undefined =>
  nonEmptyArray(tryParseArray<{ fieldId: string; agg: string }>(params.get("aggregations"), ["fieldId", "agg"])) as
    | RecordsUrlQuery["aggregations"]
    | undefined;

const parseColumnsParam = (params: URLSearchParams): RecordsUrlQuery["columns"] | undefined => {
  const parsed = tryParseJson<unknown>(params.get("columns"));
  if (!Array.isArray(parsed)) return undefined;
  const columns = parsed.flatMap((item) => {
    const result = ColumnSpecSchema.safeParse(item);
    return result.success ? [result.data] : [];
  });
  return nonEmptyArray(columns);
};

const parseDeletedOnlyParam = (params: URLSearchParams): true | undefined => (params.get("trash") === "1" ? true : undefined);

const parseRecordsQuery = (params: URLSearchParams): RecordsUrlQuery =>
  Object.fromEntries([
    ...entryOf("filter", parseFilterParam(params)),
    ...entryOf("recordMeta", parseRecordMetaParam(params)),
    ...entryOf("sort", parseSortParam(params)),
    ...entryOf("groupBy", parseGroupByParam(params)),
    ...entryOf("groupSort", parseGroupSortParam(params)),
    ...entryOf("aggregations", parseAggregationsParam(params)),
    ...entryOf("columns", parseColumnsParam(params)),
    ...entryOf("deletedOnly", parseDeletedOnlyParam(params)),
  ]) as RecordsUrlQuery;

const csvParam = (value: string | null): string[] => (value ? value.split(",").filter(Boolean) : []);

const parseSearchState = (params: URLSearchParams): RecordsState["search"] => ({
  q: (params.get("q") ?? "").trim(),
  fieldIds: csvParam(params.get("qFields")),
  override: params.has("q") || params.has("qFields"),
});

const isCalendarView = (value: string | null): value is RecordsState["calendar"]["view"] =>
  value === "day" || value === "week" || value === "month" || value === "year";

const todayKey = () => new Date().toISOString().slice(0, 10);

const parseCalendarState = (params: URLSearchParams): RecordsState["calendar"] => {
  const view = params.get("cv");
  const date = params.get("cd");
  return {
    view: isCalendarView(view) ? view : "month",
    date: date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : todayKey(),
  };
};

const parseCardSize = (value: string | null): CardSize =>
  value === "small" || value === "large" || value === "medium" ? value : DEFAULT_CARD_SIZE;

/**
 * Reads URLSearchParams and produces a typed RecordsState. Bad / missing
 * params produce empty fragments — never throws.
 *
 * Pure UI state only — the active table or view lives in the
 * URL path now (path-based routing) and are read at the SSR handler
 * boundary via `c.req.param("tableId" / "viewId")`, not
 * here.
 */
export const parseRecordsState = (params: URLSearchParams): RecordsState => ({
  query: parseRecordsQuery(params),
  cursor: params.get("cursor") || null,
  selectedRecordId: params.get("record") || null,
  // Free-text search lives outside RecordQuery (SSR merges it into the filter
  // tree before the service call so ad-hoc typing layers cleanly on top of
  // saved-view filters).
  search: parseSearchState(params),
  calendar: parseCalendarState(params),
  cardSize: parseCardSize(params.get("cardSize")),
});

export type UrlPathContext = {
  baseId: string;
  tableId: string;
  /** When set, the URL goes `/table/<t>/view/<v>` instead of just
   *  `/table/<t>`. Drives the sidebar's "active view" highlight too. */
  viewId: string | null;
};

export const recordsPath = (path: UrlPathContext): string =>
  path.viewId ? `/app/grids/${path.baseId}/table/${path.tableId}/view/${path.viewId}` : `/app/grids/${path.baseId}/table/${path.tableId}`;

// Stable JSON.stringify is fine for equality here — both sides come
// from the same Zod-validated shapes, so key order is stable in practice.
const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

const matchesRecordQuery = (query: RecordsUrlQuery, viewQuery: RecordQuery | null | undefined, key: keyof RecordsUrlQuery): boolean =>
  Boolean(viewQuery && sameJson(query[key], viewQuery[key]));

const hasUrlValue = (value: unknown): boolean => Boolean(value) && (!Array.isArray(value) || value.length > 0);

const appendJsonOverride = (url: URL, query: RecordsUrlQuery, viewQuery: RecordQuery | null | undefined, key: keyof RecordsUrlQuery) => {
  const value = query[key];
  if (hasUrlValue(value) && !matchesRecordQuery(query, viewQuery, key)) url.searchParams.set(key, JSON.stringify(value));
};

const viewSearchOf = (viewQuery: RecordQuery | null | undefined): { q: string; fieldIds: string[] } | null =>
  viewQuery?.search
    ? {
        q: viewQuery.search.q.trim(),
        fieldIds: viewQuery.search.fieldIds ?? [],
      }
    : null;

const searchMatchesView = (search: RecordsState["search"], viewSearch: { q: string; fieldIds: string[] } | null): boolean =>
  Boolean(viewSearch && search.q.trim() === viewSearch.q && sameJson(search.fieldIds, viewSearch.fieldIds));

const shouldWriteSearchOverride = (search: RecordsState["search"], viewSearch: { q: string; fieldIds: string[] } | null): boolean =>
  search.override === true ? Boolean(search.q || viewSearch) : Boolean(search.q && !searchMatchesView(search, viewSearch));

const appendSearchOverride = (url: URL, search: RecordsState["search"], viewQuery: RecordQuery | null | undefined) => {
  const viewSearch = viewSearchOf(viewQuery);
  if (!shouldWriteSearchOverride(search, viewSearch)) return;

  url.searchParams.set("q", search.q);
  if (search.fieldIds.length > 0) url.searchParams.set("qFields", search.fieldIds.join(","));
};

/**
 * Builds the URL representation for the records page. Inverse of
 * parseRecordsState + the path-based routes registered in
 * [baseId]/table/[tableId][/view/[viewId]]/page.tsx.
 *
 * `viewQuery` is the active view's stored query (or null when no view
 * is active). When passed, query fields whose value exactly matches
 * the view's stored value are OMITTED from the URL — they fall through
 * to `view.query` at the next render via `resolveEffectiveQuery`, so
 * the URL stays a pure list of "user overrides on top of the view".
 *
 * Why this matters: without the suppression, opening a clean view URL
 * (e.g. `/grids/X/table/Y/view/Z`) and then paginating would write the
 * merged effective query — including the view's filter — into the
 * query string. Bookmarking that result freezes the view's filter at
 * navigation time, so a later edit to the saved view stays invisible
 * to the bookmark. Suppressing matches keeps view URLs symbolic
 * ("the view, as it stands") rather than denormalized snapshots.
 */
export const buildRecordsUrl = (path: UrlPathContext, state: RecordsState, viewQuery?: RecordQuery | null): string => {
  const url = new URL(recordsPath(path), "http://x");

  const { query, search } = state;
  appendJsonOverride(url, query, viewQuery, "filter");
  const recordMeta = query.recordMeta;
  if (hasUrlValue(recordMeta) && !matchesRecordQuery(query, viewQuery, "recordMeta"))
    url.searchParams.set("meta", JSON.stringify(recordMeta));
  appendJsonOverride(url, query, viewQuery, "sort");
  appendJsonOverride(url, query, viewQuery, "groupBy");
  appendJsonOverride(url, query, viewQuery, "groupSort");
  appendJsonOverride(url, query, viewQuery, "aggregations");
  appendJsonOverride(url, query, viewQuery, "columns");
  if (query.deletedOnly) url.searchParams.set("trash", "1");

  appendSearchOverride(url, search, viewQuery);
  if (state.cursor) url.searchParams.set("cursor", state.cursor);
  if (state.selectedRecordId) url.searchParams.set("record", state.selectedRecordId);
  if (state.calendar.view !== "month") url.searchParams.set("cv", state.calendar.view);
  if (state.calendar.date !== todayKey()) url.searchParams.set("cd", state.calendar.date);
  if (state.cardSize !== DEFAULT_CARD_SIZE) url.searchParams.set("cardSize", state.cardSize);

  return `${url.pathname}${url.search}`;
};
