/**
 * Page templates in the notebook workspace: the real sidebar with its "New note" menu, and a note editor with the
 * empty-note offer, composed as in NoteEditor.client.tsx. The test serves the notebook API with invented data.
 */
import { EditorView } from "@codemirror/view";
import { createEditor } from "@k2b/editor";
import { AppWorkspace, LocaleProvider, ScrollArea } from "@k2b/ui";
import { TextEditor } from "@k2b/ui/text-editor";
import { createSignal, Show } from "solid-js";
import { render } from "solid-js/web";
import { editor } from "../../../lib/editor";
import { handleSoftNoteNavigationRequests } from "../../../lib/soft-navigation";
import { notebookWorkspaceMessages } from "../../messages";
import NotebookSidebar from "../sidebar/NotebookSidebar.island";
import type { NotebookContext } from "../sidebar/types";
import { EmptyNoteTemplates } from "./EmptyNoteTemplates";
import { isBlankNoteText } from "./page-templates";
import { slashCommandsExtension } from "./slash-commands";
import { NOTE_EDITOR_MAX_LENGTH } from "./table-structure";

declare global {
  interface Window {
    mountTemplates: (ctx: NotebookContext, locale: string, doc: string) => void;
    templateHarness: {
      ready: () => boolean;
      text: () => string;
      /** Where the title line and the editor's content end, to prove the offer moves nothing. */
      layout: () => { titleBottom: number; contentHeight: number; scrollHeight: number };
      selection: () => string;
    };
    openedNotes: string[];
  }
}

window.openedNotes = [];

window.mountTemplates = (ctx, locale, doc) => {
  const host = document.getElementById("root");
  if (!host) throw new Error("Missing harness root");
  document.documentElement.lang = locale;
  const t = notebookWorkspaceMessages.resolve([locale]).t;
  handleSoftNoteNavigationRequests(async (href) => {
    window.openedNotes.push(href);
    return { kind: "applied", href };
  });
  const [view, setView] = createSignal<EditorView>();
  const [blank, setBlank] = createSignal(isBlankNoteText(doc));
  const [layoutTick, setLayoutTick] = createSignal(0);
  let scrollPort: HTMLDivElement | undefined;
  let commentsHost: HTMLDivElement | undefined;
  const extensions = createEditor();
  extensions.use(editor.basicExtensions());
  extensions.use(
    slashCommandsExtension({ notebookId: ctx.notebook.id, notebookName: ctx.notebook.name, locale, openTablePicker: () => {} }),
  );
  extensions.use(editor.markdownExtension());
  extensions.use(() => editor.customLightInit());
  extensions.use(editor.noteScroller);
  extensions.use(
    EditorView.updateListener.of((update) => {
      if (update.docChanged) setBlank(isBlankNoteText(update.state.doc));
      if (update.docChanged || update.geometryChanged || update.viewportChanged) setLayoutTick((tick) => tick + 1);
    }),
  );

  window.templateHarness = {
    ready: () => Boolean(view()),
    text: () => view()?.state.doc.toString() ?? "",
    selection: () => {
      const current = view();
      if (!current) return "";
      const { from, to } = current.state.selection.main;
      return current.state.sliceDoc(from, to);
    },
    layout: () => {
      const current = view();
      if (!current || !scrollPort) throw new Error("Editor not ready");
      const title = current.contentDOM.querySelector(".cm-line")!.getBoundingClientRect();
      return {
        titleBottom: Math.round(title.bottom),
        contentHeight: Math.round(current.contentDOM.getBoundingClientRect().height),
        scrollHeight: scrollPort.scrollHeight,
      };
    },
  };

  render(
    () => (
      <LocaleProvider locale={locale}>
        <AppWorkspace mobileSurface="flush" class="notebooks-workspace flex-1 min-h-0">
          <NotebookSidebar ctx={ctx} />
          <AppWorkspace.Content>
            <AppWorkspace.Main scroll={false}>
              <div class="notebook-document-surface flex flex-1 min-w-0 min-h-0 flex-col">
                <ScrollArea ref={scrollPort} class="relative min-h-0 flex-1 cursor-text">
                  <div ref={commentsHost} class="notebook-comments-host">
                    <TextEditor
                      label={t.editorSurface}
                      initialValue={doc}
                      mode="formatted"
                      presentation={() => []}
                      toolbar={false}
                      extensions={extensions.extension()}
                      maxLength={NOTE_EDITOR_MAX_LENGTH}
                      onReady={(controller, controls) => {
                        extensions.attach(controller.view, { controller, controls });
                        setView(controller.view);
                      }}
                    />
                    <Show when={blank()}>
                      <EmptyNoteTemplates view={view} host={() => commentsHost} notebookId={ctx.notebook.id} layout={layoutTick} />
                    </Show>
                  </div>
                </ScrollArea>
              </div>
            </AppWorkspace.Main>
          </AppWorkspace.Content>
        </AppWorkspace>
      </LocaleProvider>
    ),
    host,
  );
};
