import { z } from "zod";
import { DOCUMENT_CATALOG_SORTS, type DocumentCatalogSort, DocumentMediaTypeSchema } from "../../../api/document-public-contracts";
import { ShortIdSchema } from "../../../contracts";

/** Reloadable state of the Base-wide **All documents** catalog. */
export type DocumentCatalogState = {
  q: string;
  view: "folders" | "list";
  path: string[];
  workflow: string | null;
  template: string | null;
  table: string | null;
  mediaType: string | null;
  sort: DocumentCatalogSort;
};

export const DEFAULT_DOCUMENT_CATALOG_STATE: DocumentCatalogState = {
  q: "",
  view: "folders",
  path: [],
  workflow: null,
  template: null,
  table: null,
  mediaType: null,
  sort: "newest",
};

const FolderSchema = z.union([ShortIdSchema, z.string().regex(/^workflow:[A-Za-z0-9]{6}$/)]);
const YearSchema = z.string().regex(/^\d{4}$/);

const parsePath = (value: string | null): string[] => {
  const [folder, year, ...rest] = value ? value.split("/") : [];
  if (!folder || rest.length > 0 || !FolderSchema.safeParse(folder).success) return [];
  if (year === undefined) return [folder];
  return YearSchema.safeParse(year).success ? [folder, year] : [folder];
};

const parsed = <T>(schema: z.ZodType<T>, value: string | null): T | null => {
  const result = schema.safeParse(value);
  return result.success ? result.data : null;
};

/** Invalid values fall back to their defaults so a stale or edited URL still opens the catalog. */
export const parseDocumentCatalogUrlState = (params: URLSearchParams): DocumentCatalogState => ({
  q: params.get("q")?.trim() ?? "",
  view: params.get("view") === "list" ? "list" : "folders",
  path: parsePath(params.get("path")),
  workflow: parsed(ShortIdSchema, params.get("workflow")),
  template: parsed(ShortIdSchema, params.get("template")),
  table: parsed(ShortIdSchema, params.get("table")),
  mediaType: parsed(DocumentMediaTypeSchema, params.get("type")),
  sort: DOCUMENT_CATALOG_SORTS.find((sort) => sort === params.get("sort")) ?? DEFAULT_DOCUMENT_CATALOG_STATE.sort,
});

/** Search, a filter or a non-default sort shows one flat, newest-first-by-default list instead of folders. */
export const documentCatalogIsFlat = (state: DocumentCatalogState): boolean =>
  Boolean(state.q.trim()) ||
  state.view === "list" ||
  Boolean(state.workflow || state.template || state.table || state.mediaType) ||
  state.sort !== DEFAULT_DOCUMENT_CATALOG_STATE.sort;

export const documentCatalogUrlHref = (currentUrl: URL, state: DocumentCatalogState): string => {
  const url = new URL(currentUrl);
  const entries: Array<[string, string | null]> = [
    ["q", state.q.trim() || null],
    ["view", state.view === "list" ? "list" : null],
    ["path", documentCatalogIsFlat(state) || state.path.length === 0 ? null : state.path.join("/")],
    ["workflow", state.workflow],
    ["template", state.template],
    ["table", state.table],
    ["type", state.mediaType],
    ["sort", state.sort === DEFAULT_DOCUMENT_CATALOG_STATE.sort ? null : state.sort],
  ];
  for (const [key, value] of entries) {
    if (value === null) url.searchParams.delete(key);
    else url.searchParams.set(key, value);
  }
  return `${url.pathname}${url.search}${url.hash}`;
};
