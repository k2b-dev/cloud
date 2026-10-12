import { forceParsing } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { runContextAwareCommand } from "@k2b/cloud/browser/commands";
import { collectContextAwareCommands } from "@k2b/cloud/browser/testing";
import { AppWorkspace, DetailPanel, LocaleProvider, ScrollArea, useLocale } from "@k2b/ui";
import { createSignal, onCleanup, onMount } from "solid-js";
import { render } from "solid-js/web";
import { editor } from "../../lib/editor";
import { fadeScrollMarginsExtension, fadeScrollPadding } from "../../lib/editor/fade-scroll-margins";
import { listCommandsExtension } from "../../lib/editor/list-commands";
import { notebookWorkspaceMessages } from "../messages";
import { keepBookReadingPosition } from "./book/book-reading-position";
import { FullWidthSection } from "./detail/FullWidthSection";
import { keepReadingPosition } from "./editor/reading-position";
import { followFullWidth } from "./full-width";
import { parseFullWidth, readFullWidth } from "./settings/NotebookSettingsStore";

const book = new URLSearchParams(location.search).get("mode") === "book";
const initial = parseFullWidth(document.cookie);
const markdown = document.getElementById("note-source")!.textContent!;
const html = document.getElementById("book-source")!.textContent!;
let port: HTMLDivElement | undefined;
let article: HTMLElement | undefined;
let host: HTMLDivElement | undefined;
let view: EditorView | undefined;
let anchorFrom = 0;
let anchorBlock: Element | undefined;
const [panelOpen, setPanelOpen] = createSignal(true);

function Harness() {
  const locale = useLocale();
  const t = () => notebookWorkspaceMessages.resolve([locale()]).t;
  onMount(() => {
    if (!port) throw new Error("No scroll port.");
    if (!book) {
      view = new EditorView({
        parent: host!,
        state: EditorState.create({
          doc: markdown,
          selection: { anchor: markdown.length },
          extensions: [
            editor.basicExtensions(),
            editor.markdownExtension(),
            editor.searchTheme(),
            fadeScrollMarginsExtension(() => port),
            editor.noteScrollerTheme,
            editor.customLightInit(),
            listCommandsExtension(),
            editor.tablesExtension("book01"),
            editor.imageExtension("book01"),
            editor.listsExtension(),
            editor.infoBlocksExtension("de"),
            editor.dataBlocksExtension(),
            editor.namedBlocksExtension(),
            editor.linksExtension("book01"),
            editor.markupExtension(),
            editor.markExtension(),
            editor.subSupExtension(),
            editor.ligaturesExtension(),
            editor.initialMarkdownDecorationRefreshExtension(),
            editor.pointerSelectionMarkdownRefreshExtension(),
            editor.mermaidExtension(),
            editor.katexExtension(),
            editor.codeFontExtension(),
            editor.tagPillExtension("book01"),
          ],
        }),
      });
      forceParsing(view, markdown.length, 5000);
      onCleanup(() => view?.destroy());
    }
    followFullWidth(
      port,
      () => (book && article && port ? keepBookReadingPosition(article, port) : view && port ? keepReadingPosition(view, port) : null),
      t,
    );
  });
  return (
    <AppWorkspace mobileSurface="flush" class="h-full" resizable={false}>
      <AppWorkspace.Sidebar defaultSize={256} label="Notizbuch">
        Notizbuch
      </AppWorkspace.Sidebar>
      <AppWorkspace.Content>
        <AppWorkspace.Main scroll={false}>
          <div class="notebook-document-surface flex flex-1 min-w-0 min-h-0 flex-col" data-full-width={initial ? "" : undefined}>
            <ScrollArea ref={port} class="relative min-h-0 flex-1" style={{ "scroll-padding-block": fadeScrollPadding }}>
              {book ? <article ref={article} class="notebook-book-content" innerHTML={html} /> : <div ref={host} />}
            </ScrollArea>
          </div>
        </AppWorkspace.Main>
        <AppWorkspace.Detail id="full-width-test" open={panelOpen()}>
          <DetailPanel>
            <DetailPanel.Body>
              <nav>Ansichten</nav>
              <FullWidthSection initial={initial} />
              <DetailPanel.Section title="Inhalt" icon="ti ti-list">
                Einleitung und Planung
              </DetailPanel.Section>
              <DetailPanel.Section title="Informationen" icon="ti ti-info-circle">
                Unsere gemeinsame Notiz
              </DetailPanel.Section>
            </DetailPanel.Body>
          </DetailPanel>
        </AppWorkspace.Detail>
      </AppWorkspace.Content>
    </AppWorkspace>
  );
}

render(
  () => (
    <LocaleProvider locale="de">
      <Harness />
    </LocaleProvider>
  ),
  document.getElementById("root")!,
);
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
const settle = async () => {
  await document.fonts.ready;
  let last = "";
  let stable = 0;
  for (let count = 0; count < 120 && stable < 5; count++) {
    await frame();
    const now = `${port!.scrollTop} ${port!.scrollHeight} ${view?.documentTop} ${view?.contentHeight}`;
    stable = now === last ? stable + 1 : 0;
    last = now;
  }
};
const rect = (element: Element) => {
  const { x, y, width, height } = element.getBoundingClientRect();
  return { x, y, width, height };
};
const harness = {
  settle,
  measure: () => {
    const paragraph = book
      ? article!.querySelector("p")!
      : Array.from(view!.contentDOM.querySelectorAll(".cm-line")).find((line) => line.textContent?.startsWith("Absatz "))!;
    const owner = book ? port! : view!.scrollDOM;
    const inset = book
      ? Number.parseFloat(getComputedStyle(article!).paddingLeft) + Number.parseFloat(getComputedStyle(article!).paddingRight)
      : 0;
    const style = getComputedStyle(owner);
    return {
      width: paragraph.getBoundingClientRect().width,
      available: owner.clientWidth - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight) - inset,
    };
  },
  scrollMiddle: async () => {
    const prefix = "Absatz 60.";
    if (book) {
      anchorBlock = Array.from(article!.querySelectorAll("p")).find((element) => element.textContent?.startsWith(prefix))!;
      port!.scrollTop += anchorBlock.getBoundingClientRect().top - port!.getBoundingClientRect().top;
    } else {
      anchorFrom = markdown.indexOf(prefix);
      view!.dispatch({ effects: EditorView.scrollIntoView(anchorFrom, { y: "start", yMargin: 0 }) });
      await settle();
      const top = view!.coordsAtPos(anchorFrom, 1)!.top;
      port!.scrollTop += top - port!.getBoundingClientRect().top;
    }
    await settle();
  },
  anchor: () =>
    (book ? anchorBlock!.getBoundingClientRect().top : view!.coordsAtPos(anchorFrom, 1)!.top) - port!.getBoundingClientRect().top,
  /** Capture the first frame that can paint after the native switch change. */
  firstPaint: () =>
    new Promise<number>((resolve) => {
      document.querySelector('input[role="switch"]')!.addEventListener(
        "change",
        () => {
          requestAnimationFrame(() => resolve(harness.anchor()));
        },
        { once: true },
      );
    }),
  panelRects: () => {
    const panel = document.querySelector(".k2b-detail-panel")!;
    const body = panel.querySelector(".k2b-detail-panel__body")!;
    return [panel, ...body.children, panel.querySelector(".k2b-switch__track")!].map(rect);
  },
  command: () => {
    const command = collectContextAwareCommands().find((command) => command.id === "notebooks.view.fullWidth");
    return command ? { title: command.title, icon: command.icon, description: command.description, shortcut: command.shortcut } : null;
  },
  runCommand: async () => {
    const command = collectContextAwareCommands().find((command) => command.id === "notebooks.view.fullWidth");
    if (!command) throw new Error("Full-width command is not registered.");
    await runContextAwareCommand(command);
  },
  stored: readFullWidth,
  setPanelOpen: (open: boolean) => setPanelOpen(open),
};
export type FullWidthHarness = typeof harness;
Object.assign(window, { harness });
