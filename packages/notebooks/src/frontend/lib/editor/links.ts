import { syntaxTree } from "@codemirror/language";
import type { EditorState, Extension, Range } from "@codemirror/state";
import { RangeSet } from "@codemirror/state";
import { Decoration, EditorView, WidgetType } from "@codemirror/view";
import { markdownFileType, markdownReferenceIcon, markdownReferenceType } from "@k2b/ui";
import { anchorHash, parseNoteLink } from "../../../lib/heading-anchors";
import { openAttachmentById } from "../attachment-preview";
import { navigateToNotebookNote } from "../soft-navigation";
import { type CursorZoneState, cursorZoneStateField, selectionIntersectsRange } from "./_lib/cursor-zone-field";
import { buildAttachmentContentUrl, extractAttachmentId, isSafeMarkdownUrl } from "./attachment-url";

type LinkData = {
  label: string;
  url: string;
  /** Resolved final href (rewritten for attachment URLs, identity otherwise). */
  resolvedUrl: string;
  isNoteLink: boolean;
  /** The note link names a heading of the note. */
  isHeadingLink: boolean;
  /** Set if the link is an `attach://<shortId>` reference to a non-image blob. */
  attachmentId: string | null;
  notebookId: string;
};

class LinkWidget extends WidgetType {
  constructor(private linkData: LinkData) {
    super();
  }

  override toDOM() {
    const { attachmentId, isNoteLink, label } = this.linkData;
    if (attachmentId || isNoteLink) {
      // A reference renders as the shared calm pill of rendered Markdown: icon
      // and text, no brackets. The whole pill acts — an attachment opens its
      // preview (or asks to download), a note link navigates — while the editor
      // keeps its cursor. The pill is drawn by `.k2b-reference`, so hover only
      // darkens its fill and nothing moves.
      const type = attachmentId
        ? markdownFileType(label)
        : markdownReferenceType({ kind: this.linkData.isHeadingLink ? "heading" : "note" }, label);
      const el = document.createElement("span");
      el.className = `k2b-reference ${attachmentId ? "cm-attachment-pill" : "cm-note-link"}`;
      el.dataset.reference = type;
      el.title = attachmentId ? label : this.linkData.url;

      const icon = document.createElement("i");
      icon.className = `k2b-reference__icon ti ${markdownReferenceIcon(type, label)}`;
      icon.setAttribute("aria-hidden", "true");

      el.append(icon, label);

      el.onmousedown = (e) => {
        e.preventDefault();
        e.stopPropagation();
      };
      el.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        // `note://<shortId>` is internal and not navigable; `resolvedUrl`
        // carries the full path. The shared helper uses client-side editor
        // navigation when mounted and falls back to SSR navigation otherwise.
        if (attachmentId) void openAttachmentById(this.linkData.notebookId, attachmentId, label);
        else void navigateToNotebookNote(this.linkData.resolvedUrl);
      };

      return el;
    }

    // Web and mail links read like rendered ones: prose text with a thin
    // accent underline. Clicking the text positions the cursor for editing;
    // the small ↗ of a web link opens it in a new tab.
    const container = document.createElement("span");
    container.className = "cm-link-widget";

    const labelSpan = document.createElement("span");
    labelSpan.className = "cm-link-label k2b-text-link";
    labelSpan.textContent = label;
    container.appendChild(labelSpan);

    if (!/^(?:mailto|tel):/i.test(this.linkData.url)) {
      const iconSpan = document.createElement("i");
      iconSpan.className = "cm-link-icon k2b-text-link__external ti ti-arrow-up-right";
      iconSpan.title = this.linkData.url;
      iconSpan.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        window.open(this.linkData.url, "_blank", "noopener,noreferrer");
      };
      container.appendChild(iconSpan);
    }
    return container;
  }

  override eq(other: WidgetType) {
    return (
      other instanceof LinkWidget &&
      other.linkData.label === this.linkData.label &&
      other.linkData.url === this.linkData.url &&
      other.linkData.isNoteLink === this.linkData.isNoteLink &&
      other.linkData.isHeadingLink === this.linkData.isHeadingLink &&
      other.linkData.attachmentId === this.linkData.attachmentId
    );
  }

  override ignoreEvent(event: Event) {
    const target = event.target as HTMLElement;
    // Note-link & attachment-pill swallow their own events — they navigate
    // via onclick and CM should not try to position the cursor.
    if (target.closest(".cm-note-link") !== null) return true;
    if (target.closest(".cm-attachment-pill") !== null) return true;
    // External link: only the icon click is "ours"; label click should pass
    // through so CM positions the cursor for editing.
    return target.closest(".cm-link-icon") !== null;
  }
}

const parseLinkSyntax = (text: string, notebookId: string): LinkData | null => {
  const match = text.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
  if (!match || !match[1] || !match[2]) return null;
  const url = match[2];
  const attachmentId = extractAttachmentId(url);
  // Internal `note://<shortId>` links, also to a heading, render as pills rather than external links.
  const note = parseNoteLink(url);
  if (!attachmentId && !note && !isSafeMarkdownUrl(url)) return null;
  // Note links resolve to `/app/notebooks/<currentNotebookShortId>/notes/<targetShortId>`.
  // We assume same-notebook (the most common case); cross-notebook
  // references resolve via the page-handler's lenient lookup, which
  // 404s gracefully if the target lives elsewhere.
  const resolvedUrl = attachmentId
    ? buildAttachmentContentUrl(notebookId, attachmentId)
    : note
      ? `/app/notebooks/${encodeURIComponent(notebookId)}/notes/${encodeURIComponent(note.noteId)}${anchorHash(note.anchor)}`
      : url;
  return {
    label: match[1],
    url,
    resolvedUrl,
    isNoteLink: note !== null,
    isHeadingLink: Boolean(note?.anchor),
    attachmentId,
    notebookId,
  };
};

const findLinks = (state: EditorState, notebookId: string): CursorZoneState => {
  const decorations: Range<Decoration>[] = [];
  const ranges: { from: number; to: number }[] = [];
  const cursor = state.selection.main;

  syntaxTree(state).iterate({
    enter: ({ type, from, to }) => {
      if (type.name !== "Link") return;
      ranges.push({ from, to });
      if (selectionIntersectsRange(cursor, from, to)) return;

      const text = state.doc.sliceString(from, to);
      const linkData = parseLinkSyntax(text, notebookId);

      if (linkData) {
        decorations.push(Decoration.replace({ widget: new LinkWidget(linkData) }).range(from, to));
      }
    },
  });

  return {
    decorations: decorations.length > 0 ? RangeSet.of(decorations, true) : Decoration.none,
    ranges,
  };
};

export const linksExtension = (notebookId: string): Extension => {
  const stateField = cursorZoneStateField((state) => findLinks(state, notebookId));

  const theme = EditorView.theme({
    ".cm-link-icon": {
      cursor: "pointer",
    },
    ".cm-note-link, .cm-attachment-pill": {
      cursor: "pointer",
    },
  });

  const eventHandlers = EditorView.domEventHandlers({
    mousedown(event, view) {
      const target = event.target as HTMLElement;
      // Note-link & attachment-pill clicks are handled by the widget's own
      // onclick (note-link navigates same-window, attachment opens its
      // preview). Bail out so CM doesn't reposition the cursor.
      if (target.closest(".cm-note-link") || target.closest(".cm-attachment-pill")) {
        return true;
      }
      if (target.closest(".cm-link-label")) {
        const pos = view.posAtDOM(target);
        if (pos !== null) {
          view.dispatch({ selection: { anchor: pos } });
          return true;
        }
      }
      return false;
    },
  });

  return [stateField, theme, eventHandlers];
};
