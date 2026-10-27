import { isolateHistory } from "@codemirror/commands";
import { syntaxTree } from "@codemirror/language";
import { type EditorState, type Extension, StateEffect, StateField } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { pastedCloudLink, resolveCloudUrl } from "@k2b/cloud/browser/resource-links";
import { cloudResourceHref } from "@k2b/cloud/contracts/resource-href";

type CloudResource = { ref: { type: string; id: string }; title: string };
type Range = { from: number; to: number };
type Pending = { id: number; ranges: readonly Range[] };

/** The Markdown link a recognized resource becomes. A note keeps the editor's own `note://` form for backlinks. */
export const cloudResourceMarkdownLink = ({ ref, title }: CloudResource): string => {
  const label = title
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[\\[\]]/g, (character) => `\\${character}`);
  const href = ref.type === "notebooks.note" ? `note://${ref.id}` : cloudResourceHref(ref).replace(/\(/g, "%28").replace(/\)/g, "%29");
  return `[${label}](${href})`;
};

/** A link pasted into code, an autolink, or the destination of a Markdown link stays as it is. */
const keepsText = (state: EditorState, from: number): boolean => {
  if (state.sliceDoc(Math.max(0, from - 2), from) === "](") return true;
  for (
    let node: ReturnType<ReturnType<typeof syntaxTree>["resolveInner"]> | null = syntaxTree(state).resolveInner(from, 1);
    node;
    node = node.parent
  )
    if (/code|link|image/i.test(node.name)) return true;
  return false;
};

const addPending = StateEffect.define<Pending>();
const dropPending = StateEffect.define<number>();

/**
 * The pasted links that wait for recognition, mapped through every edit. A link that is edited, deleted, or undone
 * before Cloud answers leaves the list, so recognition never touches other text.
 */
const pendingLinks = StateField.define<readonly Pending[]>({
  create: () => [],
  update(value, tr) {
    let next = value;
    if (tr.docChanged)
      next = next.flatMap((pending) => {
        const ranges = pending.ranges.flatMap((range) => {
          let touched = false;
          tr.changes.iterChangedRanges((from, to) => {
            if (from < range.to && to > range.from) touched = true;
          });
          return touched ? [] : [{ from: tr.changes.mapPos(range.from, 1), to: tr.changes.mapPos(range.to, -1) }];
        });
        return ranges.length > 0 ? [{ ...pending, ranges }] : [];
      });
    for (const effect of tr.effects) {
      if (effect.is(addPending)) next = [...next, effect.value];
      else if (effect.is(dropPending)) next = next.filter((pending) => pending.id !== effect.value);
    }
    return next;
  },
});

let nextId = 0;

const recognize = (view: EditorView, link: string, pasted: string) => {
  // CodeMirror has pasted the text at every cursor; each one now ends behind its copy.
  const offset = pasted.indexOf(link);
  const ranges = view.state.selection.ranges.flatMap((selection) => {
    const from = selection.head - pasted.length + offset;
    return from >= 0 && view.state.sliceDoc(from, from + link.length) === link && !keepsText(view.state, from)
      ? [{ from, to: from + link.length }]
      : [];
  });
  if (ranges.length === 0) return;
  const id = ++nextId;
  view.dispatch({ effects: addPending.of({ id, ranges }) });
  void resolveCloudUrl(link).then((resource) => {
    if (!view.dom.isConnected) return;
    const pending = view.state.field(pendingLinks).find((entry) => entry.id === id);
    if (!pending) return;
    const changes = resource
      ? pending.ranges
          .filter((range) => view.state.sliceDoc(range.from, range.to) === link && !keepsText(view.state, range.from))
          .map((range) => ({ ...range, insert: cloudResourceMarkdownLink(resource) }))
      : [];
    // One undo step of its own: undo brings back the plain link, not an empty line.
    view.dispatch({
      changes,
      effects: dropPending.of(id),
      ...(changes.length > 0 ? { annotations: isolateHistory.of("full"), userEvent: "input.paste" } : {}),
    });
  });
};

/**
 * A pasted Cloud link turns into a Markdown link with the resource's title once Cloud recognizes it for this person;
 * an unknown or unreadable link stays text. Undo brings the plain link back, and Ctrl+Shift+V keeps it from the start.
 */
export const cloudLinkPasteExtension = (): Extension => [
  pendingLinks,
  EditorView.domEventHandlers({
    paste(event, view) {
      const link = pastedCloudLink(event);
      if (!link) return false;
      // The clipboard is readable only during the event; CodeMirror inserts the text right after this handler.
      const pasted = (event.clipboardData?.getData("text/plain") ?? "").replace(/\r\n?/g, "\n");
      queueMicrotask(() => recognize(view, link, pasted));
      return false;
    },
  }),
];
