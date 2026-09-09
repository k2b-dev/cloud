import { mutation as mutations, query, timed } from "@k2b/stdlib/solid";
import { Button, prompts, useLocale } from "@k2b/ui";
import { createEffect, createSignal } from "solid-js";
import { apiClient } from "@/api/client";
import { PUBLIC_DOCUMENT_PAGE_LIMIT } from "../../../api/document-public-contracts";
import { errorMessage } from "../utils/api-helpers";
import DocumentBrowser from "./DocumentBrowser";
import DocumentBrowserToolbar from "./DocumentBrowserToolbar";
import { openDocumentDetailsDialog } from "./DocumentDetailsDialog";
import {
  activeDocumentViewMode,
  documentBrowserEmptyText,
  documentBrowserKey,
  documentCountLabel,
  serializeDocumentBrowserKey,
} from "./document-browser-model";
import { downloadPdfResponse } from "./document-download";
import { requestDocumentDownload } from "./document-transfer-client";
import { documentMessages } from "./messages";
import type { PublicDocument, PublicDocumentBrowseResponse } from "./public-document-types";

type PermissionLevel = "none" | "read" | "write" | "admin";

const loadPage = async (
  key: ReturnType<typeof documentBrowserKey>,
  cursor?: string | null,
  signal?: AbortSignal,
  locale = "en",
): Promise<PublicDocumentBrowseResponse> => {
  const response = await apiClient.documents["by-base"][":baseId"].browse.$get(
    {
      param: { baseId: key.templateId },
      query: { limit: String(PUBLIC_DOCUMENT_PAGE_LIMIT), cursor: cursor ?? "", q: key.search, mode: key.mode, path: key.path.join("/") },
    },
    signal ? { init: { signal } } : undefined,
  );
  if (!response.ok) throw new Error(await errorMessage(response, documentMessages.resolve([locale]).t.couldNotLoadDocuments));
  return response.json();
};

export default function DocumentsWorkspace(props: {
  baseId: string;
  documentTemplateLevels: Record<string, PermissionLevel>;
  initialBrowserPage: PublicDocumentBrowseResponse;
}) {
  const locale = useLocale();
  const t = () => documentMessages.resolve([locale()]).t;
  const [searchDraft, setSearchDraft] = createSignal("");
  const [search, setSearch] = createSignal("");
  const [mode, setMode] = createSignal<"list" | "folders">("folders");
  const [path, setPath] = createSignal<string[]>([]);
  const debounce = timed.debounce((value: string) => setSearch(value.trim()), 250);
  createEffect(() => debounce.debouncedFn(searchDraft()));
  const key = () => documentBrowserKey(props.baseId, mode(), search(), path());
  const pages = query.createInfinite<ReturnType<typeof documentBrowserKey>, PublicDocumentBrowseResponse, string>({
    source: key,
    isSameSource: (a, b) => serializeDocumentBrowserKey(a) === serializeDocumentBrowserKey(b),
    initial: { source: key(), pages: [props.initialBrowserPage] },
    loadPage: (source, { cursor, abortSignal }) => loadPage(source, cursor, abortSignal, locale()),
    getNextCursor: (page) => (page.hasMore ? (page.cursor ?? undefined) : undefined),
  });
  const [busyDocumentId, setBusyDocumentId] = createSignal<string | null>(null);

  const documents = () => pages.pages().flatMap((page) => page.items);
  const folders = () => pages.pages()[0]?.folders ?? [];
  const activeMode = () => activeDocumentViewMode(mode(), search());
  const breadcrumbs = () => [
    { label: t().allDocuments, path: [] },
    ...path().map((part, index) => ({
      label: index === 0 ? (props.initialBrowserPage.folders.find((folder) => folder.key === part)?.label ?? part) : part,
      path: path().slice(0, index + 1),
    })),
  ];
  const canWrite = (document: PublicDocument) => {
    const level = props.documentTemplateLevels[document.templateId] ?? "none";
    return level === "write" || level === "admin";
  };
  const downloadDocument = async (document: PublicDocument, signal?: AbortSignal) => {
    const response = await requestDocumentDownload(document.id, signal);
    await downloadPdfResponse(response, document.filename, locale());
  };

  const downloadMut = mutations.create<void, PublicDocument, { documentId: string }>({
    onBefore: (document) => {
      setBusyDocumentId(document.id);
      return { documentId: document.id };
    },
    mutation: (document, { abortSignal }) => downloadDocument(document, abortSignal),
    onError: (error) => prompts.error(error.message),
    onFinally: (ctx) => {
      if (ctx?.documentId === busyDocumentId()) setBusyDocumentId(null);
    },
  });

  const openDetails = (document: PublicDocument) =>
    void openDocumentDetailsDialog({
      document,
      templateName: props.initialBrowserPage.folders.find((folder) => folder.key === document.templateId)?.label,
      canWrite: canWrite(document),
      onDownload: downloadDocument,
    });

  return (
    <div class="flex h-full min-h-0 flex-col gap-2 overflow-hidden" data-scroll-preserve="grids-documents-workspace">
      <header class="flex shrink-0 items-center justify-between gap-3 px-4 py-3">
        <div>
          <h2 class="text-base font-semibold text-primary">{t().allDocuments}</h2>
          <p class="text-xs text-dimmed">{t().allDocumentsDescription}</p>
        </div>
        <Button variant="secondary" size="sm" type="button" onClick={() => void pages.refresh()} disabled={pages.refreshing()}>
          <i class={pages.refreshing() ? "ti ti-loader-2 animate-spin" : "ti ti-refresh"} />
          {t().refresh}
        </Button>
      </header>
      <DocumentBrowserToolbar
        canWrite={false}
        searchDraft={searchDraft}
        setSearchDraft={setSearchDraft}
        clearSearch={() => {
          debounce.cancel();
          setSearchDraft("");
          setSearch("");
        }}
        activeMode={activeMode()}
        searching={Boolean(search())}
        countLabel={documentCountLabel(activeMode(), folders(), documents(), pages.hasMore(), locale())}
        onGenerate={() => {}}
        onMode={(next) => {
          setMode(next);
          setPath([]);
        }}
      />
      <DocumentBrowser
        loading={pages.loading() || pages.refreshing()}
        error={pages.error() ?? undefined}
        mode={activeMode()}
        searching={Boolean(search())}
        folders={folders()}
        documents={documents()}
        breadcrumbs={breadcrumbs()}
        emptyText={documentBrowserEmptyText(search(), activeMode(), path(), locale())}
        hasMore={pages.hasMore()}
        loadingMore={pages.loadingMore()}
        busyDocumentId={busyDocumentId()}
        canWrite={false}
        folderTitle={(folder) => folder.label}
        onBreadcrumb={setPath}
        onFolder={(folder) => setPath(folder.path)}
        onDocument={openDetails}
        onEdit={openDetails}
        onLink={() => {}}
        onDownload={(document) => void downloadMut.mutate(document)}
        onLoadMore={() => void pages.loadMore()}
      />
    </div>
  );
}
