import { syntaxTree } from "@codemirror/language";
import type { EditorState, Extension, Range } from "@codemirror/state";
import { RangeSet } from "@codemirror/state";
import { Decoration, EditorView, WidgetType } from "@codemirror/view";
import { parseSizedMarkdownImage } from "../../../lib/markdown-image";
import { openAttachedImage } from "../attachment-preview";
import {
  blockWidgetLineNavigationExtension,
  type CursorZoneState,
  cursorZoneStateField,
  selectionIntersectsRange,
} from "./_lib/cursor-zone-field";
import {
  attachmentFromContentUrl,
  buildAttachmentContentUrl,
  confirmAndDownload,
  extractAttachmentId,
  isSafeMarkdownUrl,
} from "./attachment-url";

/** `attach://<shortId>` → `/api/notebooks/<nbid>/attachments/<shortId>/content`. */
const resolveUrl = (rawUrl: string, notebookId: string): string => {
  const id = extractAttachmentId(rawUrl);
  return id ? buildAttachmentContentUrl(notebookId, id) : rawUrl;
};

class ImageWidget extends WidgetType {
  constructor(
    private url: string,
    private alt: string,
    private width: string | null,
    private height: string | null,
    private title: string | null,
  ) {
    super();
  }

  override toDOM() {
    const container = document.createElement("div");
    container.className = "cm-image-widget cursor-pointer";
    container.setAttribute("contenteditable", "false");
    container.setAttribute("tabindex", "0");

    const figure = document.createElement("figure");
    figure.className = "flex flex-col items-start max-w-full";

    const img = document.createElement("img");
    // Drop the `max-h-[400px]` cap when an explicit size is requested so
    // the user's `=WxH` actually wins.
    img.className =
      this.width || this.height
        ? "block rounded border border-gray-200 dark:border-gray-700"
        : "block max-h-[400px] rounded border border-gray-200 dark:border-gray-700";
    img.src = this.url;
    img.alt = this.alt || "";
    if (this.title !== null) img.title = this.title;
    img.loading = "lazy";
    // The suffix reserves the image's place before it loads: width and height give the aspect ratio, a width alone its
    // width. The image never grows past the column; a height alone keeps the image's proportions inside that height.
    img.style.maxWidth = "100%";
    if (this.width) img.setAttribute("width", this.width);
    if (this.height) img.setAttribute("height", this.height);
    if (this.height && !this.width) {
      img.style.height = `${this.height}px`;
      img.style.objectFit = "contain";
    } else {
      img.style.height = "auto";
    }

    if (this.alt) {
      const caption = document.createElement("figcaption");
      caption.className = "text-sm text-gray-500 dark:text-gray-400 mt-2 italic";
      caption.textContent = this.alt;
      figure.appendChild(img);
      figure.appendChild(caption);
    } else {
      figure.appendChild(img);
    }

    container.appendChild(figure);

    // Click → an attachment opens in the lightbox, any other image keeps the
    // download confirm. Stop propagation so CM doesn't reposition the cursor
    // (consistent with the file-pill widget).
    const open = () => {
      const attachment = attachmentFromContentUrl(this.url, window.location.href);
      if (attachment) openAttachedImage(img, attachment.notebookId, attachment.attachmentId, this.alt);
      else void confirmAndDownload(this.alt || "image", this.url);
    };
    container.onmousedown = (e) => {
      e.preventDefault();
      e.stopPropagation();
    };
    container.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      open();
    };
    container.onkeydown = (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      e.stopPropagation();
      open();
    };

    return container;
  }

  override eq(other: WidgetType) {
    return (
      other instanceof ImageWidget &&
      other.url === this.url &&
      other.alt === this.alt &&
      other.width === this.width &&
      other.height === this.height &&
      other.title === this.title
    );
  }

  override ignoreEvent(event: Event) {
    return event.type !== "mousedown";
  }
}

/** Source-byte ranges of every Image node (incl. the next-line
 *  source-visible extension). Drives the cursor-zone rebuild gate. */
const findMarkdownImages = (state: EditorState, notebookId: string): CursorZoneState => {
  const decorations: Range<Decoration>[] = [];
  const atomicDecorations: Range<Decoration>[] = [];
  const ranges: { from: number; to: number }[] = [];
  const cursor = state.selection.main;

  syntaxTree(state).iterate({
    enter: (node) => {
      if (node.type.name !== "Image") return;

      const prevLine = state.doc.lineAt(Math.max(node.from - 1, 0));
      const nextLine = state.doc.lineAt(Math.min(node.to + 1, state.doc.length));
      ranges.push({ from: prevLine.from, to: nextLine.to });
      if (selectionIntersectsRange(cursor, prevLine.from, nextLine.to)) return false;

      const text = state.sliceDoc(node.from, node.to);
      const sized = parseSizedMarkdownImage(text);
      const urlNode = node.node.getChild("URL");
      if (!sized && !urlNode) return false;
      const marks = node.node.getChildren("LinkMark");
      const titleNode = node.node.getChild("LinkTitle");
      const alt = sized ? sized.alt : state.sliceDoc(marks[0]!.to, marks[1]!.from);
      const href = sized ? sized.href : state.sliceDoc(urlNode!.from, urlNode!.to);
      const title = sized ? sized.title : titleNode ? state.sliceDoc(titleNode.from + 1, titleNode.to - 1) : null;
      const width = sized?.width == null ? null : String(sized.width);
      const height = sized?.height == null ? null : String(sized.height);
      const resolvedUrl = resolveUrl(href, notebookId);
      if (!isSafeMarkdownUrl(resolvedUrl)) return false;
      const imageDecoration = Decoration.replace({
        widget: new ImageWidget(resolvedUrl, alt, width, height, title),
        block: true,
      }).range(node.from, node.to);
      decorations.push(imageDecoration);
      atomicDecorations.push(imageDecoration);
    },
  });

  return {
    decorations: decorations.length > 0 ? RangeSet.of(decorations, true) : Decoration.none,
    atomicDecorations: atomicDecorations.length > 0 ? RangeSet.of(atomicDecorations, true) : Decoration.none,
    ranges,
  };
};

export const imageExtension = (notebookId: string): Extension => {
  const stateField = cursorZoneStateField((state) => findMarkdownImages(state, notebookId));

  const theme = EditorView.theme({
    ".cm-image-widget": {
      display: "block",
      margin: "0 !important",
      lineHeight: "1",
    },
    ".cm-image-widget:focus": {
      outline: "2px solid var(--color-blue-500)",
      outlineOffset: "2px",
      borderRadius: "4px",
    },
  });

  // No view-level mousedown handler needed — the widget container swallows
  // its own clicks (preventDefault + stopPropagation in toDOM).
  return [stateField, blockWidgetLineNavigationExtension(stateField, (value) => value.atomicDecorations), theme];
};
