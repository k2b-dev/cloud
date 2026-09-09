import type { CapabilityActionManifest, CapabilityQueryManifest } from "@k2b/cloud/contracts";
import type { CapabilityKind, CapabilitySortDirection, CapabilitySortKey } from "./routes";

export const CAPABILITIES_PER_PAGE = 50;

export type CapabilityTableState = {
  search: string;
  sort: CapabilitySortKey;
  direction: CapabilitySortDirection;
  page: number;
};

export type CapabilityOperationRow = {
  kind: CapabilityKind;
  localId: string;
  id: string;
  title: string;
  description: string;
  policy: "Read only" | "Write" | "Destructive";
};

export type CapabilityOperationPage = {
  rows: CapabilityOperationRow[];
  total: number;
  totalPages: number;
  page: number;
};

const SORT_KEYS = new Set<CapabilitySortKey>(["kind", "title", "id", "policy"]);
const MAX_SEARCH_LENGTH = 200;
const MAX_PAGE = 1_000_000;

export const parseCapabilityTableState = (url: URL): CapabilityTableState => {
  const rawPage = url.searchParams.get("page") ?? "1";
  const requestedPage = /^\d{1,7}$/.test(rawPage) ? Number.parseInt(rawPage, 10) : 1;
  const requestedSort = url.searchParams.get("sort") as CapabilitySortKey | null;
  const requestedDirection = url.searchParams.get("direction");

  return {
    search: (url.searchParams.get("search") ?? "").trim().slice(0, MAX_SEARCH_LENGTH),
    sort: requestedSort && SORT_KEYS.has(requestedSort) ? requestedSort : "title",
    direction: requestedDirection === "desc" ? "desc" : "asc",
    page: Number.isSafeInteger(requestedPage) && requestedPage > 0 ? Math.min(requestedPage, MAX_PAGE) : 1,
  };
};

export const capabilityOperationRows = (
  appId: string,
  queries: readonly CapabilityQueryManifest[],
  actions: readonly CapabilityActionManifest[],
): CapabilityOperationRow[] => [
  ...queries.map((operation) => ({
    kind: "query" as const,
    localId: operation.localId,
    id: `${appId}.${operation.localId}`,
    title: operation.title,
    description: operation.description,
    policy: "Read only" as const,
  })),
  ...actions.map((operation) => ({
    kind: "action" as const,
    localId: operation.localId,
    id: `${appId}.${operation.localId}`,
    title: operation.title,
    description: operation.description,
    policy: operation.destructive ? ("Destructive" as const) : ("Write" as const),
  })),
];

const compareText = (left: string, right: string): number => left.localeCompare(right, undefined, { sensitivity: "base", numeric: true });

const valueForSort = (row: CapabilityOperationRow, sort: CapabilitySortKey): string => {
  if (sort === "kind") return row.kind;
  if (sort === "id") return row.id;
  if (sort === "policy") return row.policy;
  return row.title;
};

export const paginateCapabilityOperations = (
  operations: readonly CapabilityOperationRow[],
  state: CapabilityTableState,
): CapabilityOperationPage => {
  const needle = state.search.toLocaleLowerCase();
  const filtered = needle
    ? operations.filter((row) => `${row.kind} ${row.title} ${row.id} ${row.description} ${row.policy}`.toLocaleLowerCase().includes(needle))
    : [...operations];

  filtered.sort((left, right) => {
    const primary = compareText(valueForSort(left, state.sort), valueForSort(right, state.sort));
    const stable = primary || compareText(left.title, right.title) || compareText(left.id, right.id);
    return state.direction === "desc" ? -stable : stable;
  });

  const totalPages = Math.max(1, Math.ceil(filtered.length / CAPABILITIES_PER_PAGE));
  const page = Math.min(state.page, totalPages);
  const offset = (page - 1) * CAPABILITIES_PER_PAGE;

  return {
    rows: filtered.slice(offset, offset + CAPABILITIES_PER_PAGE),
    total: filtered.length,
    totalPages,
    page,
  };
};
