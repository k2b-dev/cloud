import type { LinkNavigateEvent } from "@k2b/ssr/nav";
import type { DateContext } from "@k2b/stdlib";
import { query as queries } from "@k2b/stdlib/solid";
import { useLocale } from "@k2b/ui";
import { Bar, Button, Failed, FilterBar, Input, List, ListOrder, Menu, Pane, Path, Row, Table, Tabs, Text } from "@k2b/ui/v2";
import { createMemo, createSignal, onCleanup, onMount, Show } from "solid-js";
import { apiClient } from "../../../api/client";
import { PUBLIC_DOCUMENT_PAGE_LIMIT, type PublicDocumentCatalogFacets } from "../../../api/document-public-contracts";
import type { WorkspaceRevision } from "../../../service/workspace-revision";
import GridsFrame, { LiveNotice } from "../frame/GridsFrame";
import { errorMessage } from "../utils/api-helpers";
import type { NavigationState } from "../workspace/navigation-catalog";
import { openDocumentDetailsDialog } from "./DocumentDetailsDialog";
import { documentBrowserEmptyText, documentCountLabel } from "./document-browser-model";
import { type DocumentCatalogState, documentCatalogIsFlat, parseDocumentCatalogUrlState } from "./document-catalog-url-state";
import { downloadPdfResponse } from "./document-download";
import { requestDocumentDownload } from "./document-transfer-client";
import { documentFormatLabel } from "./document-workspace-utils";
import { catalogOf, type DocumentsListState, documentsHref, documentsQuery, listStateOf } from "./documents-query";
import { documentMessages } from "./messages";
import type { PublicDocument, PublicDocumentBrowseResponse, PublicDocumentFolder } from "./public-document-types";

type PermissionLevel = "none" | "read" | "write" | "admin";

export type DocumentsScreenProps = {
  frame: NavigationState;
  revision?: WorkspaceRevision;
  baseId: string;
  canWriteDocuments: boolean;
  documentTemplateLevels: Record<string, PermissionLevel>;
  /** Workflows whose runs this viewer can open; other workflow origins are shown without a link. */
  linkableWorkflowIds: string[];
  initialCatalog: DocumentCatalogState;
  facets: PublicDocumentCatalogFacets;
  initialBrowserPage: PublicDocumentBrowseResponse;
  dateConfig?: DateContext;
};

const FOLDER_ICON: Record<PublicDocumentFolder["kind"], string> = {
  template: "file-type-pdf",
  workflow: "route",
  year: "calendar",
  month: "calendar-month",
};

/**
 * Every completed document of a base on v2: by folder (template or workflow, then year) or as one list, searched,
 * filtered and sorted in the address. A document opens its details; folders and the list load more on demand.
 */
export default function DocumentsScreen(props: DocumentsScreenProps) {
  const locale = useLocale();
  const t = () => documentMessages.resolve([locale()]).t;
  const pathname = `/app/grids/${props.baseId}/documents`;
  const [catalog, setCatalog] = createSignal<DocumentCatalogState>(props.initialCatalog);
  const query = createMemo(() => documentsQuery(locale(), props.facets, catalog()));
  const flat = () => documentCatalogIsFlat(catalog());
  const mode = () => (flat() ? "list" : "folders");
  const href = (next: DocumentCatalogState) => documentsHref(pathname, query(), next, documentCatalogIsFlat(next));

  /** Moves to another catalog state: a folder or view pushes a step into history, a filter replaces the address. */
  const go = (next: DocumentCatalogState, event?: LinkNavigateEvent) => {
    if (event) event.push(href(next), { scroll: "top" });
    else history.replaceState(history.state, "", href(next));
    setCatalog(next);
  };
  onMount(() => {
    const step = () => setCatalog(parseDocumentCatalogUrlState(new URL(location.href).searchParams));
    addEventListener("popstate", step);
    onCleanup(() => removeEventListener("popstate", step));
  });

  const pageQuery = (state: DocumentCatalogState, cursor: string | null | undefined) => {
    const asList = documentCatalogIsFlat(state);
    return {
      limit: String(PUBLIC_DOCUMENT_PAGE_LIMIT),
      cursor: cursor ?? "",
      q: state.q,
      mode: asList ? ("list" as const) : ("folders" as const),
      path: asList ? "" : state.path.join("/"),
      sort: state.sort,
      ...(state.workflow ? { workflow: state.workflow } : {}),
      ...(state.template ? { template: state.template } : {}),
      ...(state.table ? { table: state.table } : {}),
      ...(state.mediaType ? { mediaType: state.mediaType } : {}),
    };
  };
  const pages = queries.createInfinite<DocumentCatalogState, PublicDocumentBrowseResponse, string>({
    source: catalog,
    isSameSource: (a, b) => JSON.stringify(a) === JSON.stringify(b),
    initial: { source: props.initialCatalog, pages: [props.initialBrowserPage] },
    loadPage: async (source, { cursor, abortSignal }) => {
      const response = await apiClient.documents["by-base"][":baseId"].browse.$get(
        { param: { baseId: props.baseId }, query: pageQuery(source, cursor) },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await errorMessage(response, t().couldNotLoadDocuments));
      return response.json();
    },
    getNextCursor: (page) => (page.hasMore ? (page.cursor ?? undefined) : undefined),
  });
  const documents = () => pages.pages().flatMap((page) => page.items);
  const folders = () => (flat() ? [] : (pages.pages()[0]?.folders ?? []));

  const workflowNames = () => new Map(props.facets.workflows.map((workflow) => [workflow.id, workflow.name]));
  const templateNames = () => new Map(props.facets.templates.map((template) => [template.id, template.name]));
  const folderLabel = (key: string) =>
    key.startsWith("workflow:") ? (workflowNames().get(key.slice("workflow:".length)) ?? key) : (templateNames().get(key) ?? key);
  const workflowOrigin = (document: PublicDocument) => {
    if (!document.workflowId || !document.workflowRunId) return undefined;
    return {
      name: workflowNames().get(document.workflowId) ?? document.workflowId,
      href: props.linkableWorkflowIds.includes(document.workflowId)
        ? `/app/grids/${encodeURIComponent(props.baseId)}/workflows/${encodeURIComponent(document.workflowId)}?run=${encodeURIComponent(document.workflowRunId)}`
        : null,
    };
  };
  const originText = (document: PublicDocument) =>
    workflowOrigin(document)?.name ?? (document.templateId ? templateNames().get(document.templateId) : undefined) ?? "–";
  const canWrite = (document: PublicDocument) => {
    if (document.templateId === null) return props.canWriteDocuments;
    const level = props.documentTemplateLevels[document.templateId] ?? "none";
    return level === "write" || level === "admin";
  };
  const formatDate = (value: string) =>
    new Intl.DateTimeFormat(props.dateConfig?.locale ?? locale(), {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: props.dateConfig?.timeZone,
    }).format(new Date(value));
  const formatOf = (document: PublicDocument) =>
    documentFormatLabel(document.artifacts.find((artifact) => artifact.key === document.primaryArtifactKey)?.mimeType);

  // k2b-ui gap: the document's details (artifacts, links, sharing) are their own dialog until the record-like detail
  // of a document is rebuilt on v2; it keeps every deed.
  const openDetails = (document: PublicDocument) =>
    void openDocumentDetailsDialog({
      document,
      templateName: document.templateId ? templateNames().get(document.templateId) : undefined,
      workflowOrigin: workflowOrigin(document),
      canWrite: canWrite(document),
      onDownload: async (each: PublicDocument) => {
        const response = await requestDocumentDownload(each.id);
        await downloadPdfResponse(response, each.filename, locale());
      },
    });

  const listState = (): DocumentsListState => listStateOf(query(), catalog());
  const changeList = (next: DocumentsListState) => go({ ...catalogOf(next, catalog()), path: [] });
  const filtered = () =>
    Boolean(catalog().workflow || catalog().template || catalog().table || catalog().mediaType || catalog().sort !== "newest");
  const view = (next: "folders" | "list") => ({ ...catalog(), view: next, path: [] });
  const crumbs = () => [
    { label: t().allDocuments, href: href({ ...catalog(), path: [] }) },
    ...catalog().path.map((part, index) => ({
      label: index === 0 ? folderLabel(part) : part,
      href: index === catalog().path.length - 1 ? undefined : href({ ...catalog(), path: catalog().path.slice(0, index + 1) }),
    })),
  ];

  return (
    <GridsFrame
      state={props.frame}
      activeKeys={[]}
      revision={props.revision}
      head={
        <Bar
          start={
            !flat() && catalog().path.length > 0 ? (
              <Path label={t().placeLabel} items={crumbs()} />
            ) : (
              <Tabs
                label={t().viewsLabel}
                items={[
                  { label: t().folders, icon: "folders", href: href(view("folders")), current: mode() === "folders" },
                  { label: t().listView, icon: "list", href: href(view("list")), current: mode() === "list" },
                ]}
              />
            )
          }
          end={
            <>
              <Input
                type="search"
                icon="search"
                label={t().searchDocuments}
                placeholder={t().searchDocuments}
                value={catalog().q}
                onKeyDown={(event) => {
                  if (event.isComposing) return;
                  const input = event.currentTarget as HTMLInputElement;
                  if (event.key === "Enter") go({ ...catalog(), q: input.value.trim(), path: [] });
                  if (event.key === "Escape" && input.value) {
                    input.value = "";
                    go({ ...catalog(), q: "" });
                  }
                }}
              />
              <Menu items={[{ label: t().refresh, icon: "refresh", onClick: () => void pages.refresh() }]} />
            </>
          }
        />
      }
    >
      <Pane
        label={t().allDocuments}
        scrollKey="grids-documents"
        status={
          <FilterBar
            query={query()}
            state={listState()}
            onChange={changeList}
            icons={{ workflow: "route", template: "template", table: "table", type: "file" }}
            results={documentCountLabel(mode(), folders(), documents(), pages.hasMore(), locale())}
            end={<ListOrder query={query()} state={listState()} onChange={changeList} />}
          />
        }
      >
        <LiveNotice />
        <Show
          when={!pages.error()}
          fallback={<Failed text={pages.error()?.message ?? t().couldNotLoadDocuments} onRetry={() => void pages.refresh()} />}
        >
          <Show when={folders().length > 0}>
            <List
              label={t().folders}
              items={folders()}
              rowKey={(folder) => folder.path.join("/")}
              row={(folder) => (
                <Row
                  icon={FOLDER_ICON[folder.kind]}
                  lines={[
                    folder.label || folderLabel(folder.key),
                    t().folderCount({ formatted: new Intl.NumberFormat(locale()).format(folder.count) }),
                  ]}
                  href={href({ ...catalog(), path: folder.path })}
                  onNavigate={(event) => go({ ...catalog(), path: folder.path }, event)}
                />
              )}
            />
          </Show>
          <Show when={folders().length === 0 || documents().length > 0}>
            <Table
              label={t().allDocuments}
              rows={documents()}
              rowKey={(document) => document.id}
              sticky
              loading={pages.loading() && documents().length === 0}
              open={(document) => ({ onOpen: () => openDetails(document) })}
              empty={{ icon: "files", text: documentBrowserEmptyText(catalog().q, mode(), catalog().path, locale(), filtered()) }}
              phone={(document) => ({
                lines: [document.filename, `${originText(document)} · ${formatOf(document)}`],
                time: formatDate(document.createdAt),
              })}
              columns={[
                {
                  title: t().columnFile,
                  width: { min: 200, default: 320 },
                  cell: (document) => ({ lines: [document.filename, document.number] }),
                },
                {
                  title: t().columnOrigin,
                  width: { min: 140, default: 220 },
                  drop: true,
                  // a workflow run this person can open is a link to it
                  cell: (document) => {
                    const origin = workflowOrigin(document);
                    return origin?.href ? <Text href={origin.href}>{origin.name}</Text> : originText(document);
                  },
                },
                { title: t().columnFormat, width: { min: 80, default: 100 }, drop: true, cell: formatOf },
                { title: t().columnCreated, align: "end", cell: (document) => formatDate(document.createdAt) },
              ]}
            />
          </Show>
          <Show when={pages.hasMore()}>
            <Bar
              end={
                <Button icon="chevrons-down" busy={pages.loadingMore()} onClick={() => void pages.loadMore()}>
                  {t().moreDocuments}
                </Button>
              }
            />
          </Show>
        </Show>
      </Pane>
    </GridsFrame>
  );
}
