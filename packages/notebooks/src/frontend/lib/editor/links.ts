import { syntaxTree } from "@codemirror/language";
import type { EditorState, Extension, Range } from "@codemirror/state";
import { RangeSet } from "@codemirror/state";
import { Decoration, EditorView, WidgetType } from "@codemirror/view";
import {
  type MarkdownReference,
  markdownLinkReference,
  markdownReferenceIcon,
  markdownReferenceType,
  markdownReferenceTypeLabel,
} from "@k2b/ui";
import { anchorHash, parseNoteLink } from "../../../lib/heading-anchors";
import { openAttachmentById } from "../attachment-preview";
import { navigateToNotebookNote } from "../soft-navigation";
import { type CursorZoneState, cursorZoneStateField, selectionIntersectsRange } from "./_lib/cursor-zone-field";
import { buildAttachmentContentUrl, extractAttachmentId, isSafeMarkdownUrl } from "./attachment-url";

type LinkData = {
  label: string;
  url: string;
  /** Resolved final href: a note's path for `note://`, the attachment's content URL for `attach://`, otherwise the URL. */
  resolvedUrl: string;
  /** What the link names inside Cloud, classified as Book does; `null` for a web or mail link. */
  reference: MarkdownReference | null;
  /** Set if the link is an `attach://<shortId>` reference to a non-image blob. */
  attachmentId: string | null;
  notebookId: string;
};

/** The element opens its link on click and, where the editor is read-only, from the keyboard as a link. */
const makeOpener = (el: HTMLElement, view: EditorView, open: () => void) => {
  el.classList.add("cm-link-open");
  el.setAttribute("role", "link");
  if (view.state.readOnly) el.tabIndex = 0;
  el.onmousedown = (e) => {
    e.preventDefault();
    e.stopPropagation();
  };
  el.onclick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    open();
  };
  el.onkeydown = (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    e.stopPropagation();
    open();
  };
};

class LinkWidget extends WidgetType {
  constructor(private linkData: LinkData) {
    super();
  }

  override toDOM(view: EditorView) {
    const { attachmentId, label, reference, url } = this.linkData;
    if (reference) {
      // A reference renders as the shared calm pill of rendered Markdown: icon
      // and text, no brackets, and a name that starts with its type. The whole
      // pill acts while the editor keeps its cursor: an attachment opens its
      // preview (or asks to download), anything else navigates as Book does.
      // The pill is drawn by `.k2b-reference`, so hover only darkens its fill.
      const type = markdownReferenceType(reference, label);
      const el = document.createElement("span");
      el.className = "k2b-reference";
      el.dataset.reference = type;
      el.title = attachmentId ? label : url;
      el.setAttribute("aria-label", `${markdownReferenceTypeLabel(type)}: ${label}`);

      const icon = document.createElement("i");
      icon.className = `k2b-reference__icon ti ${markdownReferenceIcon(type, label)}`;
      icon.setAttribute("aria-hidden", "true");

      el.append(icon, label);
      // `note://<shortId>` is internal and not navigable; `resolvedUrl` carries
      // the full path. The shared helper uses client-side editor navigation
      // when mounted and falls back to document navigation otherwise.
      makeOpener(el, view, () => {
        if (attachmentId) void openAttachmentById(this.linkData.notebookId, attachmentId, label);
        else void navigateToNotebookNote(this.linkData.resolvedUrl);
      });
      return el;
    }

    // Web and mail links read like rendered ones: prose text with a thin
    // accent underline. Clicking a web link's text positions the cursor for
    // editing and its small ↗ opens it in a new tab; a mail link has no arrow,
    // so its text opens it.
    const container = document.createElement("span");
    container.className = "cm-link-widget";
    const open = () => window.open(url, "_blank", "noopener,noreferrer");

    const labelSpan = document.createElement("span");
    labelSpan.className = "cm-link-label k2b-text-link";
    labelSpan.textContent = label;
    container.appendChild(labelSpan);

    if (/^(?:mailto|tel):/i.test(url)) {
      labelSpan.title = url;
      makeOpener(labelSpan, view, open);
      return container;
    }
    const iconSpan = document.createElement("i");
    iconSpan.className = "cm-link-icon k2b-text-link__external ti ti-arrow-up-right";
    iconSpan.title = url;
    iconSpan.setAttribute("aria-label", label);
    makeOpener(iconSpan, view, open);
    container.appendChild(iconSpan);
    return container;
  }

  override eq(other: WidgetType) {
    // Everything else derives from the label and the URL.
    return other instanceof LinkWidget && other.linkData.label === this.linkData.label && other.linkData.url === this.linkData.url;
  }

  override ignoreEvent(event: Event) {
    // Pills, mail labels and the ↗ act on their own and keep the editor's
    // cursor; a web link's text passes its events to CodeMirror, which then
    // positions the cursor for editing.
    return (event.target as HTMLElement).closest(".cm-link-open") !== null;
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
  // The editor has no attachment metadata, so a file's type comes from its link text.
  const reference: MarkdownReference | null = attachmentId
    ? { kind: "file" }
    : note
      ? { kind: note.anchor ? "heading" : "note" }
      : markdownLinkReference(url);
  return { label: match[1], url, resolvedUrl, reference, attachmentId, notebookId };
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
    ".cm-link-open": {
      cursor: "pointer",
    },
  });

  const eventHandlers = EditorView.domEventHandlers({
    mousedown(event, view) {
      const target = event.target as HTMLElement;
      // Pills, mail labels and the ↗ act through their own handlers. Bail out
      // so CodeMirror doesn't reposition the cursor.
      if (target.closest(".cm-link-open")) return true;
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
