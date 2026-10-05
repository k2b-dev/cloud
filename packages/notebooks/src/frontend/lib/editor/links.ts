import { syntaxTree } from "@codemirror/language";
import type { EditorState, Extension, Range } from "@codemirror/state";
import { RangeSet } from "@codemirror/state";
import { Decoration, EditorView, WidgetType } from "@codemirror/view";
import { fileIcons } from "@k2b/stdlib";
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
  /** Set if the link is an `attach://<shortId>` reference to a non-image blob. */
  attachmentId: string | null;
  notebookId: string;
};

class LinkWidget extends WidgetType {
  constructor(private linkData: LinkData) {
    super();
  }

  override toDOM() {
    const { attachmentId } = this.linkData;
    if (attachmentId) {
      // File-attachment pill: file icon + filename. Click opens the preview,
      // or asks to download a file without one — keeping the editor untouched.
      const el = document.createElement("span");
      el.className =
        "cm-attachment-pill inline-flex cursor-pointer items-center gap-1 rounded-md bg-zinc-100/80 px-1.5 py-0.5 text-zinc-700 shadow-[var(--ui-shadow-surface)] hover:bg-zinc-200/80 dark:bg-zinc-800/80 dark:text-zinc-300 dark:hover:bg-zinc-700/80";
      el.title = this.linkData.label;

      const icon = document.createElement("i");
      icon.className = `ti ${fileIcons.getFileIcon({ name: this.linkData.label, type: "file" })} text-xs`;

      const label = document.createElement("span");
      label.textContent = this.linkData.label;

      el.appendChild(icon);
      el.appendChild(label);

      el.onmousedown = (e) => {
        e.preventDefault();
        e.stopPropagation();
      };
      el.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        void openAttachmentById(this.linkData.notebookId, attachmentId, this.linkData.label);
      };

      return el;
    }

    if (this.linkData.isNoteLink) {
      // Pill-style note link: ti-connection icon + title, no [] brackets, the
      // whole pill is clickable and navigates same-window.
      const el = document.createElement("span");
      el.className =
        "cm-note-link inline-flex cursor-pointer items-center gap-1 rounded-md bg-blue-50/80 px-1.5 py-0.5 text-blue-700 shadow-[var(--ui-shadow-surface)] hover:bg-blue-100/80 dark:bg-blue-950/35 dark:text-blue-300 dark:hover:bg-blue-900/35";
      el.title = this.linkData.url;

      const icon = document.createElement("i");
      icon.className = "ti ti-connection text-xs";

      const label = document.createElement("span");
      label.textContent = this.linkData.label;

      el.appendChild(icon);
      el.appendChild(label);

      // Block CM's default cursor-positioning on widget click — our onclick
      // handler navigates instead.
      el.onmousedown = (e) => {
        e.preventDefault();
        e.stopPropagation();
      };
      el.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        // Navigate to the resolved URL — `note://<shortId>` is internal
        // and not navigable; `resolvedUrl` carries the full path. The
        // shared helper uses client-side editor navigation when mounted and
        // falls back to normal SSR navigation otherwise.
        void navigateToNotebookNote(this.linkData.resolvedUrl);
      };

      return el;
    }

    // External link: keep the established `[Label] ↗` rendering — only the
    // icon opens (in a new tab); clicking the label positions the cursor.
    const container = document.createElement("span");
    container.className = "cm-link-widget";

    const labelSpan = document.createElement("span");
    labelSpan.className = "cm-link-label font-bold text-gray-800 dark:text-gray-200";
    labelSpan.textContent = `[${this.linkData.label}]`;

    const iconSpan = document.createElement("span");
    iconSpan.className =
      "cm-link-icon cursor-pointer mb-0.25 text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-500 hover:underline";
    iconSpan.innerHTML = '<i class="ti ti-arrow-up-right text-xs"></i>';
    iconSpan.title = this.linkData.url;

    iconSpan.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      window.open(this.linkData.url, "_blank", "noopener,noreferrer");
    };

    container.appendChild(labelSpan);
    container.appendChild(iconSpan);
    return container;
  }

  override eq(other: WidgetType) {
    return (
      other instanceof LinkWidget &&
      other.linkData.label === this.linkData.label &&
      other.linkData.url === this.linkData.url &&
      other.linkData.isNoteLink === this.linkData.isNoteLink &&
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
    ".cm-link-widget": {
      display: "inline-flex",
      alignItems: "center",
      verticalAlign: "baseline",
    },
    ".cm-link-label": {
      fontFamily: "inherit",
      fontSize: "inherit",
    },
    ".cm-link-icon": {
      display: "inline-flex",
      alignItems: "center",
      opacity: "0.7",
      transition: "opacity 0.2s",
    },
    ".cm-link-widget:hover .cm-link-icon": {
      opacity: "1",
    },
    ".cm-note-link, .cm-attachment-pill": {
      verticalAlign: "baseline",
      transition: "background-color 0.15s",
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
