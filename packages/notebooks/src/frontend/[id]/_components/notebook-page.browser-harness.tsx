import { forceParsing } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { createEditor } from "@k2b/editor";
import { fadeScrollMarginsExtension, listCommandsExtension } from "@k2b/editor/markdown";
import { AppWorkspace, LocaleProvider, ScrollArea } from "@k2b/ui";
import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { render } from "solid-js/web";
import { notebookTableOptions } from "../../../lib/table-options";
import { editor } from "../../lib/editor";
import { notebookListOptions, notebookUrlOptions } from "../../lib/editor/notebook-options";
import NotebooksOverview from "../../NotebooksOverview.island";
import NotebookDetailPanel from "./detail/NotebookDetailPanel.island";
import EditorToolbar, { pillScrollPadding } from "./editor/EditorToolbar";
import { caretFormat, sameCaretFormat } from "./editor/editor-actions";
import { ReadingPills } from "./editor/page-pill";
import NotebookSidebar from "./sidebar/NotebookSidebar.island";
import type { NotebookContext } from "./sidebar/types";

/**
 * A whole note page of Cloud flach with fictional data: the real notebook sidebar, the note in the rich editor with
 * its pills, and the note's Detail. `?mode=write|read`, `?content=few|many`, `?detail=1`; `?page=overview` shows the
 * notebooks overview instead. The page's server answers the sidebar's and the Detail's requests.
 */
export type NotebookPageHarness = { mount: (ctx: NotebookContext) => void; settle: () => Promise<void> };
declare const window: Omit<Window, "harness"> & { harness: NotebookPageHarness };

const params = new URLSearchParams(location.search);
const mode = params.get("mode") === "read" ? "read" : "write";
const many = params.get("content") === "many";
const detail = params.get("detail") === "1";
const ME = "00000000-0000-4000-8000-000000000001";
const now = "2026-10-16T19:30:00.000Z";
const minutesAgo = (minutes: number) => new Date(Date.parse(now) - minutes * 60_000).toISOString();

const few = [
  "# Sicherheitsunterweisung",
  "",
  "Jede neue Person in der Werkstatt bekommt diese Unterweisung am ersten Tag. Sie wird einmal im Jahr wiederholt und im Ordner „Nachweise“ abgezeichnet.",
  "",
  "## Vor dem ersten Arbeitstag",
  "",
  "- [x] Gehörschutz und Schutzbrille ausgegeben",
  "- [x] Fluchtwege und Sammelplatz gezeigt",
  "- [ ] Einweisung an der Formatkreissäge",
  "",
  ":::warning Nie allein an der Formatkreissäge arbeiten.",
  "Eine zweite Person muss in Rufweite sein, auch bei kurzen Schnitten.",
  ":::",
  "",
  "Wie die Maschinen gereinigt werden, steht im [Reinigungsplan](https://example.com/reinigung).",
].join("\n");
const section = (index: number) =>
  [
    `## Maschine ${index}`,
    "",
    "Nach jeder Einweisung trägt die unterwiesene Person das Datum selbst ein. Lehrlinge im ersten Jahr arbeiten an der Abrichte nur unter Aufsicht. Not-Aus drücken, Maschine auslaufen lassen, dann helfen.",
    "",
    "| Maschine | Einweisung durch | Turnus |",
    "| --- | --- | --- |",
    "| Formatkreissäge | Felix Tannert | jährlich |",
    "| Kantenanleimer | Jonte Kramer | alle zwei Jahre |",
    "",
  ].join("\n");
const markdown = many ? [few, ...Array.from({ length: 8 }, (_, index) => section(index + 1))].join("\n\n") : few;

function NotePage(props: { ctx: NotebookContext }) {
  let host!: HTMLDivElement;
  let scrollPort: HTMLDivElement | undefined;
  const editorState = createEditor();
  const [format, setFormat] = createSignal(caretFormat(EditorState.create()), { equals: sameCaretFormat });
  onMount(() => {
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: markdown,
        extensions: [
          editor.basicExtensions(),
          editor.markdownExtension(),
          fadeScrollMarginsExtension(() => scrollPort),
          editor.noteScroller,
          editor.customLightInit(),
          listCommandsExtension(notebookListOptions),
          editor.tablesExtension(notebookTableOptions("Book01")),
          editor.listsExtension(notebookListOptions),
          editor.infoBlocksExtension("de"),
          editor.linksExtension(notebookUrlOptions("Book01")),
          editor.markupExtension(),
          editor.markExtension(),
          editor.codeFontExtension(),
          EditorState.readOnly.of(mode === "read"),
          EditorView.updateListener.of((update) => {
            if (update.docChanged || update.selectionSet) setFormat(caretFormat(update.state));
          }),
        ],
      }),
    });
    editorState.attach(view);
    forceParsing(view, markdown.length, 5000);
    onCleanup(() => view.destroy());
  });
  return (
    <AppWorkspace mobileSurface="flush" class="notebooks-workspace flex-1 min-h-0" head={false}>
      <NotebookSidebar ctx={props.ctx} editorToolbar />
      <AppWorkspace.Content>
        <AppWorkspace.Main scroll={false}>
          <div class="notebook-document-surface flex flex-1 min-w-0 min-h-0 flex-col" data-comments="">
            <div class="notebook-editor-frame relative flex-1 min-w-0 flex flex-col overflow-hidden" data-notebook-pills="">
              <ScrollArea ref={scrollPort} style={{ "scroll-padding-block": pillScrollPadding }} class="relative min-h-0 flex-1">
                <div ref={host} />
                <div class="notebook-editor-endgap" aria-hidden="true" />
              </ScrollArea>
              <Show
                when={mode === "write"}
                fallback={<ReadingPills notebookId="Book01" noteId="Note01" canEdit comments={{ open: 3, onOpen: () => {} }} />}
              >
                <EditorToolbar
                  connected
                  editor={editorState}
                  notebookId="Book01"
                  noteId="Note01"
                  format={format()}
                  onUndo={() => {}}
                  onRedo={() => {}}
                  comments={{ open: 3, onOpen: () => {} }}
                />
              </Show>
            </div>
          </div>
        </AppWorkspace.Main>
        <NotebookDetailPanel
          mode={mode === "read" ? "read" : "edit"}
          fullWidth={false}
          initiallyOpen={detail}
          tocItems={[
            { id: "sicherheitsunterweisung", level: 1, text: "Sicherheitsunterweisung" },
            { id: "vor-dem-ersten-arbeitstag", level: 2, text: "Vor dem ersten Arbeitstag" },
            { id: "maschinen", level: 2, text: "Maschinen" },
          ]}
          taskProgress={{ done: 2, total: 3 }}
          attachments={[]}
          backlinks={[]}
          namedBlocks={[]}
          relations={{ outgoing: [], tags: ["sicherheit", "werkstatt"] }}
          accessVisible
          canManageAccess
          currentNotebookId="Book01"
          notebookId="Book01"
          noteId="Note01"
          noteTitle="Sicherheitsunterweisung"
          contentMd={markdown}
          createdAt={minutesAgo(3 * 24 * 60)}
          updatedAt={minutesAgo(12)}
          lockedAt={null}
          historyIncomplete={false}
          isLocked={false}
          canWrite
          currentUserId={ME}
          noteAuthors={{ createdBy: null, lastEditedBy: null }}
          initialCommentsPage={{ items: [], page: 1, perPage: 30, total: 0, hasNext: false }}
          dateConfig={{ locale: "de", timeZone: "Europe/Berlin" }}
          now={now}
        />
      </AppWorkspace.Content>
    </AppWorkspace>
  );
}

const notebookNames = ["Handbuch", "Werkstatt", "Büro", "Fahrzeuge", "Lieferanten"];
const noteTitles = ["Sicherheitsunterweisung", "Reinigungsplan", "Urlaub und Vertretung", "Angebote schreiben", "Ölwechsel"];

function Overview() {
  return (
    <NotebooksOverview
      notebooks={notebookNames.map((name, index) => ({
        id: `Book0${index + 1}`,
        name,
        description: null,
        icon: null,
        noteCount: 4 + index,
        lastEditedAt: minutesAgo(30 * (index + 1)),
      }))}
      templates={[]}
      recentNotes={Array.from({ length: many ? 24 : 4 }, (_, index) => ({
        id: `Note${String(index).padStart(2, "0")}`,
        notebookId: `Book0${(index % notebookNames.length) + 1}`,
        notebookName: notebookNames[index % notebookNames.length]!,
        notebookIcon: null,
        title: noteTitles[index % noteTitles.length]!,
        updatedAt: minutesAgo(12 * (index + 1)),
      }))}
      initialActivity={{ items: [], nextCursor: null }}
      initialActivityError={null}
      initialPinnedNotebookIds={[]}
      dateConfig={{ locale: "de", timeZone: "Europe/Berlin" }}
      now={now}
    />
  );
}

window.harness = {
  mount(ctx) {
    render(
      () => (
        <LocaleProvider locale="de">
          <Show when={params.get("page") === "overview"} fallback={<NotePage ctx={ctx} />}>
            <Overview />
          </Show>
        </LocaleProvider>
      ),
      document.getElementById("root")!,
    );
  },
  async settle() {
    await document.fonts.ready;
    for (let frame = 0; frame < 8; frame++) await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  },
};
