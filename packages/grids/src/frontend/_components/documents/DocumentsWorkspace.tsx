import { mutation as mutations, query, timed } from "@k2b/stdlib/solid";
import { Button, prompts, useLocale } from "@k2b/ui";
import { createEffect, createSignal, on, onCleanup, onMount } from "solid-js";
import { apiClient } from "@/api/client";
import { PUBLIC_DOCUMENT_PAGE_LIMIT, type PublicDocumentCatalogFacets } from "../../../api/document-public-contracts";
import { errorMessage } from "../utils/api-helpers";
import DocumentBrowser, { type DocumentOrigin } from "./DocumentBrowser";
import DocumentBrowserToolbar from "./DocumentBrowserToolbar";
import DocumentCatalogFilters from "./DocumentCatalogFilters";
import { openDocumentDetailsDialog } from "./DocumentDetailsDialog";
import { documentBrowserEmptyText, documentCountLabel } from "./document-browser-model";
import {
  DEFAULT_DOCUMENT_CATALOG_STATE,
  type DocumentCatalogState,
  documentCatalogIsFlat,
  documentCatalogUrlHref,
  parseDocumentCatalogUrlState,
} from "./document-catalog-url-state";
import { downloadPdfResponse } from "./document-download";
import { requestDocumentDownload } from "./document-transfer-client";
import { documentMessages } from "./messages";
import type { PublicDocument, PublicDocumentBrowseResponse } from "./public-document-types";

type PermissionLevel = "none" | "read" | "write" | "admin";

const pageQuery = (state: DocumentCatalogState, cursor: string | null | undefined) => {
  const flat = documentCatalogIsFlat(state);
  return {
    limit: String(PUBLIC_DOCUMENT_PAGE_LIMIT),
    cursor: cursor ?? "",
    q: state.q,
    mode: flat ? ("list" as const) : ("folders" as const),
    path: flat ? "" : state.path.join("/"),
    sort: state.sort,
    ...(state.workflow ? { workflow: state.workflow } : {}),
    ...(state.template ? { template: state.template } : {}),
    ...(state.table ? { table: state.table } : {}),
    ...(state.mediaType ? { mediaType: state.mediaType } : {}),
  };
};

const loadPage = async (
  baseId: string,
  state: DocumentCatalogState,
  cursor?: string | null,
  signal?: AbortSignal,
  locale = "en",
): Promise<PublicDocumentBrowseResponse> => {
  const response = await apiClient.documents["by-base"][":baseId"].browse.$get(
    { param: { baseId }, query: pageQuery(state, cursor) },
    signal ? { init: { signal } } : undefined,
  );
  if (!response.ok) throw new Error(await errorMessage(response, documentMessages.resolve([locale]).t.couldNotLoadDocuments));
  return response.json();
};

export default function DocumentsWorkspace(props: {
  baseId: string;
  canWriteDocuments: boolean;
  documentTemplateLevels: Record<string, PermissionLevel>;
  /** Workflows whose runs this viewer can open; other workflow origins are shown without a link. */
  linkableWorkflowIds: string[];
  initialCatalog: DocumentCatalogState;
  facets: PublicDocumentCatalogFacets;
  initialBrowserPage: PublicDocumentBrowseResponse;
}) {
  const locale = useLocale();
  const t = () => documentMessages.resolve([locale()]).t;
  const [state, setState] = createSignal<DocumentCatalogState>(props.initialCatalog);
  const [searchDraft, setSearchDraft] = createSignal(props.initialCatalog.q);
  const update = (patch: Partial<DocumentCatalogState>) => {
    const next = { ...state(), ...patch };
    setState(next);
    window.history.replaceState(window.history.state, "", documentCatalogUrlHref(new URL(window.location.href), next));
  };
  const debounce = timed.debounce((value: string) => {
    if (value.trim() !== state().q) update({ q: value.trim() });
  }, 250);
  createEffect(on(searchDraft, (value) => debounce.debouncedFn(value), { defer: true }));
  onMount(() => {
    const onPopState = () => {
      const next = parseDocumentCatalogUrlState(new URL(window.location.href).searchParams);
      debounce.cancel();
      setSearchDraft(next.q);
      setState(next);
    };
    window.addEventListener("popstate", onPopState);
    onCleanup(() => window.removeEventListener("popstate", onPopState));
  });
  const flat = () => documentCatalogIsFlat(state());
  const filtered = () => Boolean(state().workflow || state().template || state().table || state().mediaType || state().sort !== "newest");
  const activeMode = () => (flat() ? "list" : "folders");
  const pages = query.createInfinite<DocumentCatalogState, PublicDocumentBrowseResponse, string>({
    source: state,
    isSameSource: (a, b) => JSON.stringify(a) === JSON.stringify(b),
    initial: { source: props.initialCatalog, pages: [props.initialBrowserPage] },
    loadPage: (source, { cursor, abortSignal }) => loadPage(props.baseId, source, cursor, abortSignal, locale()),
    getNextCursor: (page) => (page.hasMore ? (page.cursor ?? undefined) : undefined),
  });
  const workflowNames = () => new Map(props.facets.workflows.map((workflow) => [workflow.id, workflow.name]));
  const templateNames = () => new Map(props.facets.templates.map((template) => [template.id, template.name]));
  const linkable = () => new Set(props.linkableWorkflowIds);
  const workflowOrigin = (document: PublicDocument) => {
    if (!document.workflowId || !document.workflowRunId) return undefined;
    return {
      name: workflowNames().get(document.workflowId) ?? document.workflowId,
      href: linkable().has(document.workflowId)
        ? `/app/grids/${encodeURIComponent(props.baseId)}/workflows/${encodeURIComponent(document.workflowId)}?run=${encodeURIComponent(document.workflowRunId)}`
        : null,
    };
  };
  const originOf = (document: PublicDocument): DocumentOrigin | null => {
    const workflow = workflowOrigin(document);
    if (workflow) return { label: workflow.name, icon: "ti ti-route", href: workflow.href };
    const template = document.templateId ? templateNames().get(document.templateId) : undefined;
    return template ? { label: template, icon: "ti ti-template", href: null } : null;
  };
  const [busyDocumentId, setBusyDocumentId] = createSignal<string | null>(null);

  const documents = () => pages.pages().flatMap((page) => page.items);
  const folders = () => pages.pages()[0]?.folders ?? [];
  const folderLabel = (key: string) =>
    key.startsWith("workflow:") ? (workflowNames().get(key.slice("workflow:".length)) ?? key) : (templateNames().get(key) ?? key);
  const breadcrumbs = () => [
    { label: t().allDocuments, path: [] },
    ...state().path.map((part, index) => ({
      label: index === 0 ? folderLabel(part) : part,
      path: state().path.slice(0, index + 1),
    })),
  ];
  const canWrite = (document: PublicDocument) => {
    if (document.templateId === null) return props.canWriteDocuments;
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
      templateName: document.templateId ? templateNames().get(document.templateId) : undefined,
      workflowOrigin: workflowOrigin(document),
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
      <div class="flex shrink-0 flex-col gap-2 px-4">
        <DocumentBrowserToolbar
          canWrite={false}
          searchDraft={searchDraft}
          setSearchDraft={setSearchDraft}
          clearSearch={() => {
            debounce.cancel();
            setSearchDraft("");
            update({ q: "" });
          }}
          activeMode={activeMode()}
          searching={Boolean(state().q)}
          filtered={filtered()}
          countLabel={documentCountLabel(activeMode(), folders(), documents(), pages.hasMore(), locale())}
          onGenerate={() => {}}
          onMode={(view) => update({ view, path: [] })}
        />
        <DocumentCatalogFilters facets={props.facets} state={state()} onChange={(patch) => update({ ...patch, path: [] })} />
      </div>
      <DocumentBrowser
        loadFolderPage={(path, cursor, signal) =>
          loadPage(props.baseId, { ...DEFAULT_DOCUMENT_CATALOG_STATE, path }, cursor, signal, locale())
        }
        loading={pages.loading() || pages.refreshing()}
        error={pages.error() ?? undefined}
        mode={activeMode()}
        searching={flat()}
        folders={folders()}
        documents={documents()}
        breadcrumbs={breadcrumbs()}
        emptyText={documentBrowserEmptyText(state().q, activeMode(), state().path, locale(), filtered())}
        hasMore={pages.hasMore()}
        loadingMore={pages.loadingMore()}
        busyDocumentId={busyDocumentId()}
        canWrite={false}
        folderTitle={(folder) => folder.label}
        onBreadcrumb={(path) => update({ path })}
        onFolder={(folder) => update({ path: folder.path })}
        originOf={originOf}
        onDocument={openDetails}
        onEdit={openDetails}
        onLink={() => {}}
        onDownload={(document) => void downloadMut.mutate(document)}
        onLoadMore={() => void pages.loadMore()}
      />
    </div>
  );
}
