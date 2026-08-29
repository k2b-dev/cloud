import type { GridsDocumentViewMode } from "../sidebar/GridsSettingsStore";
import { documentMessages } from "./messages";
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
  locale = "en",
): string => {
  const t = documentMessages.resolve([locale]).t;
  const format = new Intl.NumberFormat(locale);
  if (mode === "folders" && folders.length > 0) {
    const count = folders.reduce((sum, folder) => sum + folder.count, 0);
    return t.documentCount({ count, formatted: format.format(count) });
  }
  return t.countDocuments({ formatted: format.format(documents.length), more: hasMore });
};

export const documentBrowserEmptyText = (search: string, mode: DocumentBrowserMode, folderPath: string[], locale = "en"): string => {
  const t = documentMessages.resolve([locale]).t;
  if (search.trim()) return t.noMatchingDocuments;
  if (mode === "folders" && folderPath.length > 0) return t.emptyFolder;
  return t.noGeneratedDocuments;
};

export const documentActionState = (canWrite: boolean, busyDocumentId: string | null, documentId: string) => ({
  showEdit: canWrite,
  showLink: canWrite,
  downloadBusy: busyDocumentId === documentId,
});
