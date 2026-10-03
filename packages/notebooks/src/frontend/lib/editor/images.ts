import { syntaxTree } from "@codemirror/language";
import type { EditorState, Extension, Range } from "@codemirror/state";
import { RangeSet } from "@codemirror/state";
import { Decoration, EditorView, WidgetType } from "@codemirror/view";
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

/** Match the optional `=WxH` size suffix Pandoc-style image syntax allows. */
const SIZE_SUFFIX_REGEX = /\s+=(\d+)?x(\d+)?$/;

type ParsedImage = {
  url: string;
  width: string | null;
  height: string | null;
};

const parseImageHref = (href: string): ParsedImage => {
  const match = SIZE_SUFFIX_REGEX.exec(href);
  if (!match) return { url: href, width: null, height: null };
  if (!match[1] && !match[2]) return { url: href, width: null, height: null };
  return {
    url: href.slice(0, match.index),
    width: match[1] ?? null,
    height: match[2] ?? null,
  };
};

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
  ) {
    super();
  }

  override toDOM() {
    const container = document.createElement("div");
    container.className = "cm-image-widget cursor-pointer";
    container.setAttribute("contenteditable", "false");
    container.setAttribute("tabindex", "0");

    const figure = document.createElement("figure");
    figure.className = "flex flex-col items-center justify-center max-w-full";

    const img = document.createElement("img");
    // Drop the `max-h-[400px]` cap when an explicit size is requested so
    // the user's `=WxH` actually wins.
    img.className =
      this.width || this.height
        ? "block rounded border border-gray-200 dark:border-gray-700"
        : "block max-h-[400px] rounded border border-gray-200 dark:border-gray-700";
    img.src = this.url;
    img.alt = this.alt || "";
    img.loading = "lazy";
    if (this.width) {
      img.setAttribute("width", this.width);
      img.style.maxWidth = `${this.width}px`;
    }
    if (this.height) img.setAttribute("height", this.height);

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
      other.height === this.height
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
      const match = text.match(/!\[([^\]]*)\]\(([^)]+)\)/);

      if (match) {
        const alt = match[1] ?? "";
        const rawHref = match[2] ?? "";
        const { url, width, height } = parseImageHref(rawHref);
        const resolvedUrl = resolveUrl(url, notebookId);
        if (!isSafeMarkdownUrl(resolvedUrl)) return false;
        const imageDecoration = Decoration.replace({
          widget: new ImageWidget(resolvedUrl, alt, width, height),
          block: true,
        }).range(node.from, node.to);
        decorations.push(imageDecoration);
        atomicDecorations.push(imageDecoration);
      }
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
