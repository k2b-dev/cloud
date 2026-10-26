import { highlight } from "@k2b/stdlib";
import { Button, NoticeCard, personColor, ScrollArea, useLocale } from "@k2b/ui";
import type { AnnotationProjection } from "../../../../lib/annotation-contracts";
import { notebookChartFrameHtml } from "../../../../lib/chart-blocks";
import { fadeScrollPadding } from "../../../lib/editor/fade-scroll-margins";
import { queryBlockMessages } from "../../../lib/editor/query-block-messages";
import { changesBetween } from "../../../lib/yjs/lazy-collab";
import { notebookWorkspaceMessages } from "../../messages";
import { commentMessages } from "../comments/messages";
import {
  NOTE_PREVIEW_BUDGET,
  NOTE_PREVIEW_ID,
  type NotePreviewLine,
  type NotePreviewMark,
  type NotePreviewPart,
  notePreviewChart,
  notePreviewLines,
} from "./note-preview";

type Props = {
  text: string;
  mode: "rich" | "source";
  historyIncomplete: boolean;
  /** The note's comments: their open passages show as the editor will show them, so nothing changes when it mounts. */
  annotations?: AnnotationProjection | null;
  /** The reader's user ID, whose own comments read as "you". */
  me?: string;
};

/** The open comments' passages in the preview's text, moved by any edit saved after the comments were read. */
const previewMarks = (projection: AnnotationProjection | null | undefined, text: string, me: string | undefined, locale: string) => {
  if (!projection?.items.length) return [];
  const t = commentMessages.resolve([locale]).t;
  const normalized = text.replace(/\r\n?/g, "\n");
  const changes = projection.text === normalized ? null : changesBetween(projection.text, normalized);
  const map = (pos: number, assoc: 1 | -1) => (changes ? changes.mapPos(Math.min(pos, changes.length), assoc) : pos);
  return projection.items
    .filter((item) => item.state === "open")
    .map((item): NotePreviewMark => {
      const from = map(item.from, 1);
      const to = item.orphan ? from : Math.max(from, map(item.to, -1));
      const name = item.author.kind === "user" && item.author.id === me ? t.you : item.author.name;
      const orphan = item.orphan || to <= from;
      return {
        id: item.id,
        from,
        to,
        color: personColor(item.author.name),
        orphan,
        label: orphan ? t.deletedPassage({ name }) : t.commentedBy({ names: name }),
      };
    });
};

const PreviewPart = (props: { part: NotePreviewPart }) =>
  typeof props.part === "string" ? (
    props.part
  ) : (
    <span class={props.part.className} {...props.part.attributes}>
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
  const lines = notePreviewLines(
    props.text,
    props.mode,
    NOTE_PREVIEW_BUDGET,
    previewMarks(props.annotations, props.text, props.me, locale()),
  );
  const chart = props.mode === "rich" ? notePreviewChart(props.text, lines) : null;
  const blocks = () => queryBlockMessages.resolve([locale()]).t;
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
              {chart && (
                // The editor's chart widget while its drawing loads (query-blocks.tsx), inert until the editor runs.
                <div class="cm-query-block-widget" role="group" aria-label={blocks().chart} inert>
                  <div class="flex justify-end gap-1 mb-1">
                    <Button size="xs" variant="ghost">
                      {blocks().showSource}
                    </Button>
                  </div>
                  <div
                    class="cm-query-block-preview notebook-book-content"
                    innerHTML={notebookChartFrameHtml(
                      chart,
                      `<p class="notebook-book-chart__status text-sm text-dimmed" role="status">${highlight.escape(blocks().loading)}</p>`,
                    )}
                  />
                </div>
              )}
            </div>
          </div>
        </ScrollArea>
      </div>
    </div>
  );
}
