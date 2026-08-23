import type { GridsDocumentViewMode } from "../sidebar/GridsSettingsStore";
import type { PublicDocument, PublicDocumentFolder } from "./public-document-types";

export type DocumentViewMode = GridsDocumentViewMode | "custom";
type DocumentBrowserMode = "list" | "folders";
type DocumentBrowserKey = { templateId: string; search: string; mode: DocumentBrowserMode; path: string[] };
type DocumentBrowserPageState = {
  documents: PublicDocument[];
  folders: PublicDocumentFolder[];
  hasMore: boolean;
  cursor: string | null;
};

export const activeDocumentViewMode = (viewMode: DocumentViewMode, search: string): DocumentBrowserMode =>
  search.trim() ? "list" : viewMode === "folders" ? "folders" : "list";

export const documentBrowserKey = (templateId: string, viewMode: DocumentViewMode, search: string, path: string[]): DocumentBrowserKey => {
  const mode = activeDocumentViewMode(viewMode, search);
  return { templateId, search, mode, path: mode === "folders" ? path : [] };
};

export const serializeDocumentBrowserKey = (key: DocumentBrowserKey): string =>
  `${key.templateId}:${key.mode}:${key.search.trim()}:${key.path.join("/")}`;

export const replaceDocumentBrowserPage = (page: {
  items: PublicDocument[];
  folders: PublicDocumentFolder[];
  hasMore: boolean;
  cursor: string | null;
}): DocumentBrowserPageState => ({
  documents: page.items,
  folders: page.folders,
  hasMore: page.hasMore,
  cursor: page.cursor,
});

export const appendDocumentBrowserPage = (
  current: DocumentBrowserPageState,
  page: { items: PublicDocument[]; hasMore: boolean; cursor: string | null },
  requestKey: string,
  currentKey: string,
): DocumentBrowserPageState =>
  requestKey === currentKey
    ? {
        ...current,
        documents: [...current.documents, ...page.items],
        hasMore: page.hasMore,
        cursor: page.cursor,
      }
    : current;

export const documentCountLabel = (
  mode: DocumentBrowserMode,
  folders: PublicDocumentFolder[],
  documents: PublicDocument[],
  hasMore: boolean,
): string => {
  if (mode === "folders" && folders.length > 0) {
    return `${folders.reduce((sum, folder) => sum + folder.count, 0)} documents`;
  }
  return `${documents.length}${hasMore ? "+" : ""} documents`;
};

export const documentBrowserEmptyText = (search: string, mode: DocumentBrowserMode, folderPath: string[]): string => {
  if (search.trim()) return "No documents match this search.";
  if (mode === "folders" && folderPath.length > 0) return "This folder is empty.";
  return "No generated documents yet.";
};

export const documentActionState = (canWrite: boolean, busyDocumentId: string | null, documentId: string) => ({
  showEdit: canWrite,
  showLink: canWrite,
  downloadBusy: busyDocumentId === documentId,
});
