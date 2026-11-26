import { WorkspaceNavigationProvider } from "@k2b/cloud/ssr/islands";
import { useLocale } from "@k2b/ui";
import { Bar, Button, Canvas, Empty, Menu, type MenuEntry, Pane, Tabs, Workspace } from "@k2b/ui/v2";
import { type Component, createSignal, onCleanup, onMount, Show } from "solid-js";
import { isServer } from "solid-js/web";
import type { AnnotationProjection } from "../../../lib/annotation-contracts";
import { navigateToNotebookNote } from "../../lib/soft-navigation";
import { buildNoteUrl } from "../../params";
import { notebookWorkspaceMessages } from "../messages";
import { bookMessages } from "./book/messages";
import { DETAIL_PANEL_STATE_EVENT, DETAIL_PANEL_TOGGLE_EVENT, RICH_MODE_CHANGED_EVENT, TOGGLE_RICH_MODE_EVENT } from "./detail/events";
import NoteDetails, { type NoteDetailsProps } from "./detail/NoteDetails";
import type { NoteEditorProps } from "./editor/NoteEditor";
import NotePreview from "./editor/NotePreview";
import { changeFullWidth, createFullWidth } from "./full-width";
import NotebookSidebarBody from "./sidebar/NotebookSidebarBody";
import { useNotebookSidebar } from "./sidebar/notebook-sidebar-state";
import type { NotebookContext } from "./sidebar/types";

export type NoteWorkspaceProps = {
  ctx: NotebookContext;
  /** Write ("edit") or Read-only ("read"). */
  mode: "edit" | "read";
  /** Edit is offered only to writers of a note that is not locked. */
  canEdit: boolean;
  /** The open note, or none (an empty notebook, or no note chosen yet). */
  note: NoteView | null;
  /** What stands in the note's place without one. */
  emptyText: string;
};

export type NoteView = {
  /** What the editor opens with; the server shows `preview` until the editor has loaded in the browser. */
  editor: NoteEditorProps;
  preview: { text: string; mode: "rich" | "source"; historyIncomplete: boolean; annotations: AnnotationProjection | null; me: string };
  /** The note's details; absent where the page shows none. */
  details: NoteDetailsProps | null;
};

/**
 * A note on v2: the notebook's sidebar, a head with the note's views (Bearbeiten, Lesen, Buch), the text view and the
 * Details toggle, the editing surface in a `Canvas`, and the details beside it. The editor itself (@k2b/editor with its
 * toolbar, slash and bubble menus, comments and sync bars) keeps its behaviour; it loads in the browser after the
 * first picture, which the server draws as the note's preview.
 */
export default function NoteWorkspace(props: NoteWorkspaceProps) {
  const locale = useLocale();
  const t = () => notebookWorkspaceMessages.resolve([locale()]).t;
  const book = () => bookMessages.resolve([locale()]).t;
  const sidebar = useNotebookSidebar({ ctx: props.ctx, editorToolbar: props.mode === "edit" });
  // The editor opens other notes of the notebook in place; the sidebar follows it, and so do the head's views.
  const note = () => sidebar.currentNoteId() ?? props.note?.editor.noteId ?? "";
  const notebook = () => props.ctx.notebook.id;
  const [detailsOpen, setDetailsOpen] = createSignal(props.note?.details?.initiallyOpen ?? false);
  const [rich, setRich] = createSignal(props.note?.editor.initialRichMode !== "source");
  const fullWidth = createFullWidth(props.ctx.fullWidth);

  // The editor loads after the first picture: the server and the first browser render both show the preview.
  const [Editor, setEditor] = createSignal<Component<NoteEditorProps>>();
  onMount(() => {
    if (props.note) void import("./editor/NoteEditor").then((module) => setEditor(() => module.default));
    const onState = (event: Event) => setDetailsOpen((event as CustomEvent<{ isOpen: boolean }>).detail.isOpen);
    const onRich = (event: Event) => setRich((event as CustomEvent<{ isRich: boolean }>).detail.isRich);
    window.addEventListener(DETAIL_PANEL_STATE_EVENT, onState);
    window.addEventListener(RICH_MODE_CHANGED_EVENT, onRich);
    onCleanup(() => {
      window.removeEventListener(DETAIL_PANEL_STATE_EVENT, onState);
      window.removeEventListener(RICH_MODE_CHANGED_EVENT, onRich);
    });
  });

  // Another view goes through the editor's leave guard, as a link click does, so unsent text is never dropped.
  // The view already shown keeps the page, the editor and its unsent text as they are.
  const shown = (mode: "write" | "readonly" | "book") =>
    (mode === "write" && props.mode === "edit") || (mode === "readonly" && props.mode === "read");
  const view = (mode: "write" | "readonly" | "book") => ({
    href: buildNoteUrl(notebook(), note(), mode),
    onNavigate: () => {
      if (!shown(mode)) void navigateToNotebookNote(buildNoteUrl(notebook(), note(), mode));
    },
  });
  const viewMenu = (): MenuEntry[] => [
    ...(props.mode === "edit"
      ? [
          {
            title: t().textView,
            choice: rich() ? "rich" : "source",
            onChoose: (value: string) => {
              if ((value === "rich") !== rich()) window.dispatchEvent(new CustomEvent(TOGGLE_RICH_MODE_EVENT));
            },
            items: [
              { label: t().formattedText, icon: "typography", value: "rich" },
              { label: t().markdownText, icon: "markdown", value: "source" },
            ],
          },
        ]
      : []),
    { label: t().fullWidth, meta: t().fullWidthHint, checked: fullWidth(), onClick: () => changeFullWidth(!fullWidth()) },
  ];

  return (
    <>
      {/* k2b-ui gap: Nav tree – the phone menu keeps the v1 navigation with the whole tree and its note menus. */}
      <WorkspaceNavigationProvider navigation={sidebar.mobileNavigation} label={props.ctx.notebook.name} />
      <Workspace
        // k2b-ui gap: Nav tree (link + fold, lazy levels, drag and drop) – the v1 sidebar body stands in the slot.
        sidebar={<NotebookSidebarBody sidebar={sidebar} />}
        detail={props.note?.details ? 300 : undefined}
        head={
          <Bar
            start={
              <Show when={props.note}>
                <Tabs
                  label={t().view}
                  items={[
                    ...(props.canEdit ? [{ label: t().openAsEdit, icon: "pencil", current: props.mode === "edit", ...view("write") }] : []),
                    { label: t().openAsRead, icon: "eye", current: props.mode === "read", ...view("readonly") },
                    { label: book().book, icon: "book", current: false, ...view("book") },
                  ]}
                />
              </Show>
            }
            end={
              <Show when={props.note}>
                <Menu label={t().view} icon="adjustments-horizontal" items={viewMenu()}>
                  {t().view}
                </Menu>
                <Show when={props.note?.details}>
                  <Button
                    icon="layout-sidebar-right"
                    label={t().detailPanel}
                    pressed={detailsOpen()}
                    keep
                    onClick={() => window.dispatchEvent(new CustomEvent(DETAIL_PANEL_TOGGLE_EVENT))}
                  />
                </Show>
              </Show>
            }
          />
        }
      >
        <Show
          when={props.note}
          fallback={
            <Pane label={props.ctx.notebook.name}>
              <Empty icon="file-text" text={props.emptyText} />
            </Pane>
          }
        >
          {(view) => (
            <Pane.Split>
              <Pane label={view().editor.noteTitle || t().untitled}>
                {/* k2b-ui gap: a Canvas cannot fill its pane; the editor keeps its own scroller, so the app's stylesheet
                    lets this one Canvas take the pane's height (app.css, `.notebook-document-surface`). */}
                <Canvas label={t().editorSurface}>
                  <div
                    class="notebook-document-surface flex flex-1 min-w-0 min-h-0 flex-col"
                    data-full-width={fullWidth() ? "" : undefined}
                    data-comments=""
                    data-detail-open={detailsOpen() ? "" : undefined}
                  >
                    {/* The editor removes the server's preview when it mounts, keeping the reader's scroll position. */}
                    <Show when={!isServer && Editor()}>
                      {(Loaded) => {
                        const Loaded_ = Loaded();
                        return <Loaded_ {...view().editor} />;
                      }}
                    </Show>
                    <NotePreview
                      text={view().preview.text}
                      annotations={view().preview.annotations}
                      me={view().preview.me}
                      mode={view().preview.mode}
                      historyIncomplete={view().preview.historyIncomplete}
                    />
                  </div>
                </Canvas>
              </Pane>
              <Show when={view().details}>{(details) => <NoteDetails {...details()} />}</Show>
            </Pane.Split>
          )}
        </Show>
      </Workspace>
    </>
  );
}
