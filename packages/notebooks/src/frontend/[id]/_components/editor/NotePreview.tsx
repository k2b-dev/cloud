import { NoticeCard, ScrollArea, useLocale } from "@k2b/ui";
import { fadeScrollPadding } from "../../../lib/editor/fade-scroll-margins";
import { notebookWorkspaceMessages } from "../../messages";
import { NOTE_PREVIEW_ID, type NotePreviewLine, type NotePreviewPart, notePreviewLines } from "./note-preview";

type Props = {
  text: string;
  mode: "rich" | "source";
  historyIncomplete: boolean;
};

const PreviewPart = (props: { part: NotePreviewPart }) =>
  typeof props.part === "string" ? (
    props.part
  ) : (
    <span class={props.part.className}>
      {props.part.children.map((part) => (
        <PreviewPart part={part} />
      ))}
    </span>
  );

/** CodeMirror draws an empty line as a `<br>`, which gives it the line height. */
const PreviewLine = (props: { line: NotePreviewLine }) => (
  <div class="notebook-note-preview__line">
    {props.line.parts.length ? props.line.parts.map((part) => <PreviewPart part={part} />) : <br />}
  </div>
);

/**
 * The note's first lines as the editor will show them, in the server HTML: the
 * same wrappers, column and type, so nothing moves when `NoteEditor` mounts and
 * removes this element. It ships no JavaScript.
 */
export default function NotePreview(props: Props) {
  const locale = useLocale();
  const t = () => notebookWorkspaceMessages.resolve([locale()]).t;
  const lines = notePreviewLines(props.text, props.mode);
  // CodeMirror sizes the gutter with a hidden spacer for the note's last line number, which can lie past the preview.
  const lastNumber = "9".repeat(String((props.text.match(/\r\n?|\n/g)?.length ?? 0) + 1).length);
  return (
    <div id={NOTE_PREVIEW_ID} data-mode={props.mode} class="relative flex-1 min-w-0 flex flex-col overflow-hidden">
      <div class="flex-1 min-w-0 flex flex-col overflow-hidden">
        {props.historyIncomplete && (
          <NoticeCard role="status" tone="warning" title={t().historyIncompleteTitle} detail={t().historyIncompleteDetail} />
        )}
        <ScrollArea class="relative min-h-0 flex-1 cursor-text" style={{ "scroll-padding-block": fadeScrollPadding }}>
          <div class="notebook-note-preview__scroller">
            <div class="notebook-note-preview__content">
              {props.mode === "source" && (
                <>
                  <div class="notebook-note-preview__number notebook-note-preview__spacer" aria-hidden="true">
                    {lastNumber}
                  </div>
                  <div class="notebook-note-preview__spacer" />
                </>
              )}
              {lines.map((line, index) =>
                props.mode === "source" ? (
                  <>
                    <div class="notebook-note-preview__number" aria-hidden="true">
                      {index + 1}
                    </div>
                    <PreviewLine line={line} />
                  </>
                ) : (
                  <PreviewLine line={line} />
                ),
              )}
            </div>
          </div>
        </ScrollArea>
      </div>
    </div>
  );
}
