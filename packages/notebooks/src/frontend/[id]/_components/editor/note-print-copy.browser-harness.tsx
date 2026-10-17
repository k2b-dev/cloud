import { AppWorkspace } from "@k2b/ui";
import { onCleanup, onMount } from "solid-js";
import { render } from "solid-js/web";
import { createNotePrintCopy } from "./note-print-copy";

export type PrintCopyHarness = { change(markdown: string): void; switchNote(markdown: string): void; dispose(): void };
declare global {
  interface Window {
    printCopyHarness: PrintCopyHarness;
  }
}
function Fixture() {
  let article!: HTMLElement;
  let markdown = document.getElementById("markdown")!.textContent!;
  let copy: ReturnType<typeof createNotePrintCopy>;
  const mount = () =>
    createNotePrintCopy(article, { notebookId: "book01", noteId: "note01", markdown: () => markdown, locale: () => "en" });
  onMount(() => {
    copy = mount();
    window.printCopyHarness = {
      change(value) {
        markdown = value;
        copy.changed();
      },
      switchNote(value) {
        copy.dispose();
        markdown = value;
        copy = mount();
      },
      dispose() {
        copy.dispose();
      },
    };
  });
  onCleanup(() => copy?.dispose());
  return (
    <AppWorkspace class="flex-1 min-h-0">
      <AppWorkspace.Sidebar label="Navigation">
        <AppWorkspace.SidebarDesktop>Notes</AppWorkspace.SidebarDesktop>
      </AppWorkspace.Sidebar>
      <AppWorkspace.Content>
        <AppWorkspace.Main scroll={false}>
          <div class="notebook-document-surface flex flex-1 min-h-0 flex-col overflow-hidden">
            <div class="editor-surface flex-1 overflow-auto">Virtualized editor</div>
            <div class="editor-toolbar">Editor controls</div>
            <article ref={article} class="notebook-book-content notebook-note-print" />
          </div>
        </AppWorkspace.Main>
        <AppWorkspace.Detail id="details" open>
          Note details
        </AppWorkspace.Detail>
      </AppWorkspace.Content>
    </AppWorkspace>
  );
}
render(() => <Fixture />, document.getElementById("root")!);
