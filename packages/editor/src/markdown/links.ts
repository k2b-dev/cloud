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
import { type CursorZoneState, cursorZoneStateField, selectionIntersectsRange } from "./_lib/cursor-zone-field";
import { makeOpener } from "./_lib/link-opener";
import { parseNoteLink } from "./lib/heading-anchors";
import { extractAttachmentId, isSafeMarkdownUrl, type MarkdownUrlOptions } from "./urls";

type LinkData = {
  label: string;
  url: string;
  /** Resolved final href: a note's path for `note://`, the attachment's content URL for `attach://`, otherwise the URL. */
  resolvedUrl: string;
  /** What the link names inside Cloud, classified as Book does; `null` for a web or mail link. */
  reference: MarkdownReference | null;
  /** Set if the link is an `attach://<shortId>` reference to a non-image blob. */
  attachmentId: string | null;
  options: MarkdownUrlOptions;
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
        if (this.linkData.options.openLink) this.linkData.options.openLink(this.linkData.resolvedUrl, url, label);
        else window.location.assign(this.linkData.resolvedUrl);
      });
      return el;
    }

    // Web and mail links read like rendered ones: prose text with a thin
    // accent underline. CodeMirror handles caret placement and selection on
    // web link text; the ↗ opens it. Mail link text opens the link.
    const container = document.createElement("span");
    container.className = "cm-link-widget";
    const open = () => window.open(this.linkData.resolvedUrl, "_blank", "noopener,noreferrer");

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
    // Pills, mail labels and the ↗ open on click and keep the editor's
    // cursor; a press on them still starts a drag selection. A web link's
    // text passes its events to CodeMirror, which then positions the cursor
    // for editing.
    return event.type !== "mousedown" && event.target instanceof Element && event.target.closest(".cm-link-open") !== null;
  }
}

const parseLinkSyntax = (text: string, options: MarkdownUrlOptions): LinkData | null => {
  const match = text.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
  if (!match || !match[1] || !match[2]) return null;
  const url = match[2];
  const attachmentId = extractAttachmentId(url);
  // Internal `note://<shortId>` links, also to a heading, render as pills rather than external links.
  const note = parseNoteLink(url);
  const resolvedUrl = options.resolveUrl?.("link", url) ?? url;
  if (!isSafeMarkdownUrl(resolvedUrl)) return null;
  // The editor has no attachment metadata, so a file's type comes from its link text.
  const reference: MarkdownReference | null = attachmentId
    ? { kind: "file" }
    : note
      ? { kind: note.anchor ? "heading" : "note" }
      : markdownLinkReference(resolvedUrl);
  return { label: match[1], url, resolvedUrl, reference, attachmentId, options };
};

const findLinks = (state: EditorState, options: MarkdownUrlOptions): CursorZoneState => {
  const decorations: Range<Decoration>[] = [];
  const ranges: { from: number; to: number }[] = [];
  const cursor = state.selection.main;

  syntaxTree(state).iterate({
    enter: ({ type, from, to }) => {
      if (type.name !== "Link") return;
      ranges.push({ from, to });
      if (selectionIntersectsRange(cursor, from, to)) return;

      const text = state.doc.sliceString(from, to);
      const linkData = parseLinkSyntax(text, options);

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

export const linksExtension = (options: MarkdownUrlOptions = {}): Extension => {
  const stateField = cursorZoneStateField((state) => findLinks(state, options));

  const theme = EditorView.theme({
    ".cm-link-open": {
      cursor: "pointer",
    },
  });

  return [stateField, theme];
};
