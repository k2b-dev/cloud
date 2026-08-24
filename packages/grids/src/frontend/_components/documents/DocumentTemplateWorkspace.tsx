import { refreshCurrentPath } from "@k2b/ssr/nav";
import type { DateContext } from "@k2b/stdlib";
import { mutation as mutations, timed as timing } from "@k2b/stdlib/solid";
import { Button, prompts } from "@k2b/ui";
import { createEffect, createSignal, Show } from "solid-js";
import { apiClient } from "../../../api/client";
import { PUBLIC_DOCUMENT_PAGE_LIMIT } from "../../../api/document-public-contracts";
import type { PublicTable as Table } from "../../../api/public-dto";
import { openDocumentTemplateEditorDialog } from "../dialogs/TableAdminDialogs";
import { type GridsDocumentViewMode, setDocumentViewMode } from "../sidebar/GridsSettingsStore";
import { errorMessage } from "../utils/api-helpers";
import DocumentBrowser, { type DocumentBreadcrumb } from "./DocumentBrowser";
import DocumentBrowserToolbar from "./DocumentBrowserToolbar";
import { openDocumentDetailsDialog } from "./DocumentDetailsDialog";
import { openDocumentGenerateDialog } from "./DocumentGenerateDialog";
import { openDocumentLinkDialog } from "./DocumentLinkDialog";
import {
  activeDocumentViewMode,
  appendDocumentBrowserPage,
  type DocumentViewMode,
  documentBrowserEmptyText,
  documentBrowserKey,
  documentCountLabel,
  replaceDocumentBrowserPage,
  serializeDocumentBrowserKey,
} from "./document-browser-model";
import { downloadPdfResponse } from "./document-download";
import { requestDocumentDownload } from "./document-transfer-client";
import { formatDocumentMonth } from "./document-workspace-utils";
import type {
  PublicDocument,
  PublicDocumentBrowseResponse,
  PublicDocumentFolder,
  PublicDocumentTemplate,
  PublicDocumentTemplateSummary,
} from "./public-document-types";

type Props = {
  baseId: string;
  table: Table;
  template: PublicDocumentTemplateSummary;
  editableTemplate: PublicDocumentTemplate | null;
  canWriteTemplate: boolean;
  canManageTemplate: boolean;
  editMode: boolean;
  initialRecordId: string | null;
  initialDocumentViewMode: GridsDocumentViewMode;
  initialBrowserPage: PublicDocumentBrowseResponse;
  dateConfig?: DateContext;
};

const fetchBrowserPage = async (
  args: ReturnType<typeof documentBrowserKey> & { cursor?: string | null; signal?: AbortSignal },
): Promise<PublicDocumentBrowseResponse> => {
  const res = await apiClient.documents["by-template"][":templateId"].browse.$get(
    {
      param: { templateId: args.templateId },
      query: {
        q: args.search,
        limit: String(PUBLIC_DOCUMENT_PAGE_LIMIT),
        cursor: args.cursor ?? "",
        mode: args.mode,
        path: args.path.join("/"),
      },
    },
    args.signal ? { init: { signal: args.signal } } : undefined,
  );
  if (!res.ok) throw new Error(await errorMessage(res, "Could not load generated documents"));
  return (await res.json()) as PublicDocumentBrowseResponse;
};

export default function DocumentTemplateWorkspace(props: Props) {
  const initialPage = replaceDocumentBrowserPage(props.initialBrowserPage);
  const [searchDraft, setSearchDraft] = createSignal("");
  const [search, setSearch] = createSignal("");
  const [viewMode, setViewMode] = createSignal<DocumentViewMode>(props.initialDocumentViewMode);
  const [folderPath, setFolderPath] = createSignal<string[]>([]);
  const [busy, setBusy] = createSignal<string | null>(null);
  const [documentItems, setDocumentItems] = createSignal<PublicDocument[]>(initialPage.documents);
  const [folderItems, setFolderItems] = createSignal<PublicDocumentFolder[]>(initialPage.folders);
  const [documentPage, setDocumentPage] = createSignal<{ hasMore: boolean; cursor: string | null }>({
    hasMore: initialPage.hasMore,
    cursor: initialPage.cursor,
  });

  const debouncedSearch = timing.debounce((next: string) => setSearch(next.trim()), 250);
  createEffect(() => debouncedSearch.debouncedFn(searchDraft()));

  const activeViewMode = () => activeDocumentViewMode(viewMode(), search());
  const currentBrowserKey = () => documentBrowserKey(props.template.id, viewMode(), search(), folderPath());
  const browserKeyString = (key = currentBrowserKey()) => serializeDocumentBrowserKey(key);
  let loadedBrowserKey = browserKeyString();
  const browserMut = mutations.create<PublicDocumentBrowseResponse, ReturnType<typeof currentBrowserKey>>({
    mutation: (key, { abortSignal }) => fetchBrowserPage({ ...key, search: key.search.trim(), signal: abortSignal }),
    onSuccess: (page) => {
      const next = replaceDocumentBrowserPage(page);
      setDocumentItems(next.documents);
      setFolderItems(next.folders);
      setDocumentPage({ hasMore: next.hasMore, cursor: next.cursor });
    },
    onError: (error) => prompts.error(error.message),
  });

  const refetchBrowser = () => browserMut.mutate(currentBrowserKey());

  createEffect(() => {
    const key = currentBrowserKey();
    const serialized = serializeDocumentBrowserKey(key);
    if (serialized === loadedBrowserKey) return;
    loadedBrowserKey = serialized;
    browserMut.mutate(key);
  });

  const loadMoreMut = mutations.create<PublicDocumentBrowseResponse, void, { key: string; cursor: string }>({
    onBefore: () => {
      const cursor = documentPage().cursor;
      if (!cursor) throw new Error("No more documents to load.");
      return { key: browserKeyString(), cursor };
    },
    mutation: async (_, { cursor, abortSignal }) => fetchBrowserPage({ ...currentBrowserKey(), cursor, signal: abortSignal }),
    onSuccess: (page, ctx) => {
      if (!ctx) return;
      const current = {
        documents: documentItems(),
        folders: folderItems(),
        hasMore: documentPage().hasMore,
        cursor: documentPage().cursor,
      };
      const next = appendDocumentBrowserPage(current, page, ctx.key, browserKeyString());
      if (next === current) return;
      setDocumentItems(next.documents);
      setDocumentPage({ hasMore: next.hasMore, cursor: next.cursor });
    },
    onError: (error) => prompts.error(error.message),
  });

  const documents = () => documentItems();
  const folders = () => folderItems();
  const countLabel = () => documentCountLabel(activeViewMode(), folders(), documents(), documentPage().hasMore);
  const folderTitle = (folder: PublicDocumentFolder) => {
    if (folder.kind === "year") return folder.label;
    const [year, month] = folder.path;
    return year && month ? formatDocumentMonth(year, month, props.dateConfig) : folder.label;
  };
  const breadcrumbs = (): DocumentBreadcrumb[] => {
    const path = folderPath();
    const items: DocumentBreadcrumb[] = [{ label: "Documents", path: [] }];
    if (path[0]) items.push({ label: path[0], path: [path[0]] });
    if (path[0] && path[1]) items.push({ label: formatDocumentMonth(path[0], path[1], props.dateConfig), path: [path[0], path[1]] });
    return items;
  };
  const setMode = (mode: DocumentViewMode) => {
    if (mode === "custom") return;
    setViewMode(mode);
    setDocumentViewMode(mode);
    if (mode !== "folders") setFolderPath([]);
  };
  const openFolder = (folder: PublicDocumentFolder) => {
    setViewMode("folders");
    setDocumentViewMode("folders");
    setFolderPath(folder.path);
  };
  const downloadDocument = async (document: PublicDocument, signal?: AbortSignal) => {
    const res = await requestDocumentDownload(document.id, signal);
    await downloadPdfResponse(res, document.filename);
  };
  const openDocumentLink = (document: PublicDocument) => {
    if (!props.canWriteTemplate) return;
    void openDocumentLinkDialog({ document, onCreated: async () => {} });
  };
  const openGenerate = (recordId = props.initialRecordId, mode: "generate" | "generate-again" = "generate") => {
    if (!props.canWriteTemplate) return;
    void openDocumentGenerateDialog({
      table: props.table,
      template: props.template,
      initialRecordId: recordId,
      mode,
      onGenerated: async () => {
        await refetchBrowser();
      },
    });
  };
  const openDocumentDetails = (document: PublicDocument) =>
    void openDocumentDetailsDialog({
      document,
      canWrite: props.canWriteTemplate,
      dateConfig: props.dateConfig,
      onDownload: (item) => downloadDocument(item),
      onGenerateAgain: (item) => openGenerate(item.recordId, "generate-again"),
    });

  const downloadMut = mutations.create<void, PublicDocument, { documentId: string }>({
    onBefore: (document) => {
      setBusy(document.id);
      return { documentId: document.id };
    },
    mutation: async (document, { abortSignal }) => downloadDocument(document, abortSignal),
    onError: (error) => prompts.error(error.message),
    onFinally: (ctx) => {
      if (ctx?.documentId && busy() === ctx.documentId) setBusy(null);
    },
  });

  const emptyText = () => documentBrowserEmptyText(search(), activeViewMode(), folderPath());

  return (
    <div class="flex h-full min-h-0 flex-col gap-2 overflow-hidden" data-scroll-preserve="grids-document-template-workspace">
      <DocumentBrowserToolbar
        canWrite={props.canWriteTemplate}
        searchDraft={searchDraft}
        setSearchDraft={setSearchDraft}
        clearSearch={() => {
          setSearchDraft("");
          setSearch("");
        }}
        activeMode={activeViewMode() === "folders" ? "folders" : "list"}
        searching={Boolean(search().trim())}
        countLabel={countLabel()}
        onGenerate={() => openGenerate()}
        onMode={setMode}
      />
      <Show when={props.editMode && props.canManageTemplate ? props.editableTemplate : null}>
        {(editableTemplate) => (
          <div class="flex shrink-0 flex-wrap items-center gap-2">
            <Button
              variant="success"
              size="sm"
              type="button"
              onClick={() =>
                openDocumentTemplateEditorDialog({
                  baseId: props.baseId,
                  tableId: props.table.id,
                  tableName: props.table.name,
                  template: editableTemplate(),
                  onSaved: () => refreshCurrentPath(),
                })
              }
            >
              <i class="ti ti-settings" />
              Manage
            </Button>
          </div>
        )}
      </Show>
      <DocumentBrowser
        loading={browserMut.loading()}
        error={browserMut.error() ?? undefined}
        mode={activeViewMode() === "folders" ? "folders" : "list"}
        searching={Boolean(search().trim())}
        folders={folders()}
        documents={documents()}
        breadcrumbs={breadcrumbs()}
        emptyText={emptyText()}
        hasMore={documentPage().hasMore}
        loadingMore={loadMoreMut.loading()}
        busyDocumentId={busy()}
        canWrite={props.canWriteTemplate}
        dateConfig={props.dateConfig}
        folderTitle={folderTitle}
        onBreadcrumb={setFolderPath}
        onFolder={openFolder}
        onDocument={openDocumentDetails}
        onEdit={openDocumentDetails}
        onLink={openDocumentLink}
        onDownload={(document) => void downloadMut.mutate(document)}
        onLoadMore={() => void loadMoreMut.mutate(undefined)}
      />
    </div>
  );
}
