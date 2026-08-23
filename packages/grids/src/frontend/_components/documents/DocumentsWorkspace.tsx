import { mutation as mutations } from "@k2b/stdlib/solid";
import { Button, prompts } from "@k2b/ui";
import { createResource, createSignal } from "solid-js";
import { apiClient } from "@/api/client";
import { errorMessage } from "../utils/api-helpers";
import DocumentBrowser from "./DocumentBrowser";
import { openDocumentDetailsDialog } from "./DocumentDetailsDialog";
import { downloadPdfResponse } from "./document-download";
import { requestDocumentDownload } from "./document-transfer-client";
import type { PublicDocument } from "./public-document-types";

type DocumentPage = { items: PublicDocument[]; cursor: string | null; hasMore: boolean };
type PermissionLevel = "none" | "read" | "write" | "admin";

const PAGE_SIZE = 100;

const loadPage = async (baseId: string, cursor?: string | null, signal?: AbortSignal): Promise<DocumentPage> => {
  const response = await apiClient.documents["by-base"][":baseId"].$get(
    { param: { baseId }, query: { limit: String(PAGE_SIZE), cursor: cursor ?? "" } },
    signal ? { init: { signal } } : undefined,
  );
  if (!response.ok) throw new Error(await errorMessage(response, "Could not load documents"));
  return response.json() as Promise<DocumentPage>;
};

export default function DocumentsWorkspace(props: {
  baseId: string;
  documentTemplateLevels: Record<string, PermissionLevel>;
}) {
  const [page, { refetch }] = createResource(() => props.baseId, (baseId) => loadPage(baseId));
  const [appended, setAppended] = createSignal<PublicDocument[]>([]);
  const [cursor, setCursor] = createSignal<string | null>(null);
  const [hasMore, setHasMore] = createSignal(false);
  const [busyDocumentId, setBusyDocumentId] = createSignal<string | null>(null);

  const documents = () => [...(page()?.items ?? []), ...appended()];
  const currentCursor = () => (appended().length > 0 ? cursor() : (page()?.cursor ?? null));
  const moreAvailable = () => (appended().length > 0 ? hasMore() : (page()?.hasMore ?? false));
  const canWrite = (document: PublicDocument) => {
    const level = props.documentTemplateLevels[document.templateId] ?? "none";
    return level === "write" || level === "admin";
  };
  const downloadDocument = async (document: PublicDocument, signal?: AbortSignal) => {
    const response = await requestDocumentDownload(document.id, signal);
    await downloadPdfResponse(response, document.filename);
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

  const loadMoreMut = mutations.create<DocumentPage, void>({
    mutation: (_, { abortSignal }) => {
      const nextCursor = currentCursor();
      if (!nextCursor) throw new Error("No more documents to load.");
      return loadPage(props.baseId, nextCursor, abortSignal);
    },
    onSuccess: (next) => {
      setAppended((current) => [...current, ...next.items]);
      setCursor(next.cursor);
      setHasMore(next.hasMore);
    },
    onError: (error) => prompts.error(error.message),
  });

  const openDetails = (document: PublicDocument) =>
    void openDocumentDetailsDialog({
      document,
      canWrite: canWrite(document),
      onDownload: downloadDocument,
    });

  return (
    <div class="flex h-full min-h-0 flex-col gap-2 overflow-hidden" data-scroll-preserve="grids-documents-workspace">
      <header class="paper flex shrink-0 items-center justify-between gap-3 px-4 py-3">
        <div>
          <h2 class="text-base font-semibold text-primary">All documents</h2>
          <p class="text-xs text-dimmed">Every completed Document from this Base, across records and templates.</p>
        </div>
        <Button
          variant="secondary"
          size="sm"
          type="button"
          onClick={() => {
            setAppended([]);
            setCursor(null);
            setHasMore(false);
            void refetch();
          }}
          disabled={page.loading}
        >
          <i class={page.loading ? "ti ti-loader-2 animate-spin" : "ti ti-refresh"} />
          Refresh
        </Button>
      </header>
      <DocumentBrowser
        loading={page.loading}
        error={page.error ?? undefined}
        mode="list"
        searching={false}
        folders={[]}
        documents={documents()}
        breadcrumbs={[]}
        emptyText="No documents yet. Generate one from a record or template."
        hasMore={moreAvailable()}
        loadingMore={loadMoreMut.loading()}
        busyDocumentId={busyDocumentId()}
        canWrite={false}
        folderTitle={(folder) => folder.label}
        onBreadcrumb={() => {}}
        onFolder={() => {}}
        onDocument={openDetails}
        onEdit={openDetails}
        onLink={() => {}}
        onDownload={(document) => void downloadMut.mutate(document)}
        onLoadMore={() => void loadMoreMut.mutate(undefined)}
      />
    </div>
  );
}
