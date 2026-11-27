import { type LinkNavigateEvent, refreshCurrentPath } from "@k2b/ssr/nav";
import type { DateContext } from "@k2b/stdlib";
import { query as queries } from "@k2b/stdlib/solid";
import { useLocale } from "@k2b/ui";
import { Bar, Button, Failed, Input, List, Menu, type MenuEntry, Pane, Path, Row, Table, Tabs } from "@k2b/ui/v2";
import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { apiClient } from "../../../api/client";
import { PUBLIC_DOCUMENT_PAGE_LIMIT } from "../../../api/document-public-contracts";
import type { PublicTable as Table_ } from "../../../api/public-dto";
import type { WorkspaceRevision } from "../../../service/workspace-revision";
import { openDocumentTemplateEditorDialog } from "../dialogs/TableAdminDialogs";
import GridsFrame, { LiveNotice } from "../frame/GridsFrame";
import { kindMark } from "../frame/kind-marks";
import { setDocumentViewMode } from "../sidebar/GridsSettingsStore";
import { errorMessage } from "../utils/api-helpers";
import type { NavigationState } from "../workspace/navigation-catalog";
import { openDocumentDetailsDialog } from "./DocumentDetailsDialog";
import { openDocumentGenerateDialog } from "./DocumentGenerateDialog";
import { documentBrowserEmptyText, documentCountLabel } from "./document-browser-model";
import { downloadPdfResponse } from "./document-download";
import { requestDocumentDownload } from "./document-transfer-client";
import { documentFileIcon, documentFormatLabel, formatDocumentMonth } from "./document-workspace-utils";
import { documentMessages } from "./messages";
import type {
  PublicDocument,
  PublicDocumentBrowseResponse,
  PublicDocumentTemplate,
  PublicDocumentTemplateSummary,
} from "./public-document-types";

/** What the address names: the view, the search, and the open year and month of the folders. */
export type TemplateDocumentsState = { mode: "list" | "folders"; q: string; path: string[] };

export type DocumentTemplateScreenProps = {
  frame: NavigationState;
  revision?: WorkspaceRevision;
  baseId: string;
  table: Table_;
  template: PublicDocumentTemplateSummary;
  editableTemplate: PublicDocumentTemplate | null;
  canWriteTemplate: boolean;
  /** A record the address names (`?record=`): generating starts with it. */
  initialRecordId: string | null;
  initialState: TemplateDocumentsState;
  initialBrowserPage: PublicDocumentBrowseResponse;
  dateConfig?: DateContext;
};

export const templateDocumentsHref = (pathname: string, state: TemplateDocumentsState): string => {
  const params = new URLSearchParams();
  if (state.q) params.set("q", state.q);
  else {
    params.set("mode", state.mode);
    if (state.mode === "folders" && state.path.length) params.set("path", state.path.join("/"));
  }
  return `${pathname}?${params}`;
};

export const parseTemplateDocumentsState = (params: URLSearchParams, fallback: "list" | "folders"): TemplateDocumentsState => {
  const q = (params.get("q") ?? "").trim();
  const requested = params.get("mode");
  const mode = q ? "list" : requested === "folders" || requested === "list" ? requested : fallback;
  return { mode, q, path: mode === "folders" ? (params.get("path") ?? "").split("/").filter(Boolean).slice(0, 2) : [] };
};

/**
 * The documents one template made, on v2: newest first as one list, or by year and month, searched in the address.
 * Generating a new one is the page's one deed; a document opens its details with download, link and generating again.
 */
export default function DocumentTemplateScreen(props: DocumentTemplateScreenProps) {
  const locale = useLocale();
  const t = () => documentMessages.resolve([locale()]).t;
  const pathname = `/app/grids/${encodeURIComponent(props.baseId)}/document/${encodeURIComponent(props.table.id)}/${encodeURIComponent(props.template.id)}`;
  const [state, setState] = createSignal<TemplateDocumentsState>(props.initialState);
  const href = (next: TemplateDocumentsState) => templateDocumentsHref(pathname, next);

  /** A folder or view pushes a step into history; a search replaces the address. */
  const go = (next: TemplateDocumentsState, event?: LinkNavigateEvent) => {
    if (event) event.push(href(next), { scroll: "top" });
    else history.replaceState(history.state, "", href(next));
    if (!next.q) setDocumentViewMode(next.mode);
    setState(next);
  };
  onMount(() => {
    const step = () => setState(parseTemplateDocumentsState(new URL(location.href).searchParams, state().mode));
    addEventListener("popstate", step);
    onCleanup(() => removeEventListener("popstate", step));
  });

  const pages = queries.createInfinite<TemplateDocumentsState, PublicDocumentBrowseResponse, string>({
    source: state,
    isSameSource: (a, b) => JSON.stringify(a) === JSON.stringify(b),
    initial: { source: props.initialState, pages: [props.initialBrowserPage] },
    loadPage: async (source, { cursor, abortSignal }) => {
      const response = await apiClient.documents["by-template"][":templateId"].browse.$get(
        {
          param: { templateId: props.template.id },
          query: {
            q: source.q,
            limit: String(PUBLIC_DOCUMENT_PAGE_LIMIT),
            cursor: cursor ?? "",
            mode: source.mode,
            path: source.path.join("/"),
          },
        },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await errorMessage(response, t().couldNotLoadGeneratedDocuments));
      return response.json();
    },
    getNextCursor: (page) => (page.hasMore ? (page.cursor ?? undefined) : undefined),
  });
  const documents = () => pages.pages().flatMap((page) => page.items);
  const folders = () => (state().mode === "folders" ? (pages.pages()[0]?.folders ?? []) : []);

  const monthName = (year: string, month: string) => formatDocumentMonth(year, month, { ...props.dateConfig, locale: locale() });
  const crumbs = () => {
    const [year, month] = state().path;
    return [
      // the sidebar names the template; the way up starts at its folders (k2b-ui gap: Path does not cut a long step)
      { label: t().folders, href: href({ ...state(), path: [] }) },
      ...(year ? [{ label: year, href: month ? href({ ...state(), path: [year] }) : undefined }] : []),
      ...(year && month ? [{ label: monthName(year, month) }] : []),
    ];
  };
  const formatDate = (value: string) =>
    new Intl.DateTimeFormat(props.dateConfig?.locale ?? locale(), {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: props.dateConfig?.timeZone,
    }).format(new Date(value));
  const formatOf = (document: PublicDocument) =>
    documentFormatLabel(document.artifacts.find((artifact) => artifact.key === document.primaryArtifactKey)?.mimeType);

  const generate = (recordId: string | null = props.initialRecordId, mode: "generate" | "generate-again" = "generate") =>
    void openDocumentGenerateDialog({
      table: props.table,
      template: props.template,
      initialRecordId: recordId,
      mode,
      onGenerated: async () => {
        await pages.refresh();
      },
    });
  // k2b-ui gap: the document's details (artifacts, links, sharing) stay their own dialog until a document detail is
  // rebuilt on v2, as on "All documents"; it keeps every deed.
  const openDetails = (document: PublicDocument) =>
    void openDocumentDetailsDialog({
      document,
      templateName: props.template.name,
      canWrite: props.canWriteTemplate,
      dateConfig: props.dateConfig,
      onDownload: async (each: PublicDocument) => {
        const response = await requestDocumentDownload(each.id);
        await downloadPdfResponse(response, each.filename, locale());
      },
      onGenerateAgain: (each) => generate(each.recordId, "generate-again"),
    });
  const editTemplate = (template: PublicDocumentTemplate) =>
    // k2b-ui gap: the template editor (Liquid source, preview, fields) stays its v1 dialog until it is rebuilt on v2.
    openDocumentTemplateEditorDialog({
      baseId: props.baseId,
      tableId: props.table.id,
      tableName: props.table.name,
      template,
      onSaved: () => refreshCurrentPath(),
    });

  const more = (): MenuEntry[] => {
    const editable = props.editableTemplate;
    return [
      { label: t().refresh, icon: "refresh", onClick: () => void pages.refresh() },
      ...(editable ? [{ label: t().manage, icon: "settings", onClick: () => editTemplate(editable) }] : []),
    ];
  };
  const mark = () => kindMark("documentTemplate");

  return (
    <GridsFrame
      state={props.frame}
      activeKeys={[`table:${props.table.id}`, `document:${props.template.id}`]}
      revision={props.revision}
      head={
        <Bar
          start={
            state().mode === "folders" && state().path.length > 0 ? (
              <Path label={t().placeLabel} items={crumbs()} />
            ) : (
              <Tabs
                label={t().viewsLabel}
                items={[
                  { label: t().listView, icon: "list", href: href({ mode: "list", q: "", path: [] }), current: state().mode === "list" },
                  {
                    label: t().folders,
                    icon: "folders",
                    href: href({ mode: "folders", q: "", path: [] }),
                    current: state().mode === "folders",
                  },
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
                value={state().q}
                onKeyDown={(event) => {
                  if (event.isComposing) return;
                  const input = event.currentTarget as HTMLInputElement;
                  if (event.key === "Enter") go({ mode: "list", q: input.value.trim(), path: [] });
                  if (event.key === "Escape" && input.value) {
                    input.value = "";
                    go({ ...state(), q: "" });
                  }
                }}
              />
              <Menu items={more()} />
              <Show when={props.canWriteTemplate}>
                <Button variant="primary" icon="file-plus" onClick={() => generate()}>
                  {t().generateDocument}
                </Button>
              </Show>
            </>
          }
        />
      }
      primary={props.canWriteTemplate ? { label: t().generateDocument, icon: "file-plus", onClick: () => generate() } : undefined}
    >
      <Pane label={props.template.name} scrollKey={`grids-template-${props.template.id}`}>
        <LiveNotice />
        <Show
          when={!pages.error()}
          fallback={<Failed text={pages.error()?.message ?? t().couldNotLoadGeneratedDocuments} onRetry={() => void pages.refresh()} />}
        >
          <Bar start={documentCountLabel(state().mode, folders(), documents(), pages.hasMore(), locale())} />
          <Show when={folders().length > 0}>
            <List
              label={t().folders}
              items={folders()}
              rowKey={(folder) => folder.path.join("/")}
              row={(folder) => {
                const [year, month] = folder.path;
                return (
                  <Row
                    mark={{ icon: folder.kind === "month" ? "calendar-month" : "calendar", color: mark().color }}
                    // one line on the desktop: the month, its count at the end
                    lines={[year && month ? `${monthName(year, month)} ${year}` : folder.label]}
                    time={t().folderCount({ formatted: new Intl.NumberFormat(locale()).format(folder.count) })}
                    href={href({ ...state(), path: folder.path })}
                    onNavigate={(event) => go({ ...state(), path: folder.path }, event)}
                  />
                );
              }}
            />
          </Show>
          <Show when={folders().length === 0}>
            <Table
              label={props.template.name}
              rows={documents()}
              rowKey={(document) => document.id}
              sticky
              loading={pages.loading() && documents().length === 0}
              open={(document) => ({ onOpen: () => openDetails(document) })}
              empty={{ icon: "file-off", text: documentBrowserEmptyText(state().q, state().mode, state().path, locale()) }}
              phone={(document) => ({
                mark: { ...kindMark("documentTemplate", documentFileIcon(document)), kind: formatOf(document) },
                lines: [document.filename, document.number],
                time: formatDate(document.createdAt),
              })}
              columns={[
                // the format stands once, in the mark; the number has its own column to compare down
                {
                  title: t().columnFile,
                  width: { min: 220, default: 320 },
                  mark: (document) => ({ ...kindMark("documentTemplate", documentFileIcon(document)), kind: formatOf(document) }),
                  cell: (document) => document.filename,
                },
                { title: t().number, width: { min: 120, default: 140 }, drop: true, cell: (document) => document.number },
                { title: t().columnCreated, width: { min: 140, default: 160 }, cell: (document) => formatDate(document.createdAt) },
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
