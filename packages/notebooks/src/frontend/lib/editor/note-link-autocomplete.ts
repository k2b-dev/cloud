/**
 * Inline autocomplete für Note-Links via `[[partial]]` Trigger.
 *
 * Mirrors the wikilink-style syntax: type `[[` (optionally followed
 * by chars of the target's title) and a popup of all notes in the
 * current notebook surfaces. Accepting an option replaces the
 * `[[…]]` (or just `[[…` if no closing brackets typed yet) with a
 * standard markdown link `[Title](note-url)`.
 *
 * # Why `[[...]]` not just `[...]`?
 *
 * `[...]` is regular markdown for link text. The autocomplete
 * shouldn't fire there — that's an alt-text region, not a target
 * lookup. The double-bracket `[[]]` form is a deliberate, distinct
 * trigger that means "I want to look up a note by title". This
 * matches conventions in Obsidian / Roam / Logseq, so users
 * coming from those tools find it natural.
 *
 * The accepted output is still standard markdown though — we don't
 * persist `[[Title]]` in the document. The `[[..]]` is just typed
 * scaffolding that gets rewritten on accept.
 *
 * # Fetching
 *
 * The server finds the notes for what the person typed, so a notebook
 * with thousands of notes offers each of them, and the popup never
 * loads more than one page of matches.
 *
 * # Scope
 *
 * Skip inside fenced code — `[[` in code blocks is literal.
 */
import {
  type Completion,
  type CompletionContext,
  type CompletionResult,
  type CompletionSource,
  pickedCompletion,
} from "@codemirror/autocomplete";
import { apiClient } from "../../../api/client";
import { withIcon } from "./completion-icon";
import { isInsideFencedCode } from "./editor-scope";

/** Lightweight note projection — only what the popup needs. */
type NoteRef = {
  id: string;
  title: string;
};

/** One page of matches and whether the notebook has more of them. */
type NotePage = {
  notes: NoteRef[];
  truncated: boolean;
};

/** Notes offered at once; the person narrows them by typing. */
const PER_PAGE = 50;

const fetchNotes = async (notebookId: string, query: string, signal: AbortSignal): Promise<NotePage> => {
  const response = await apiClient[":id"].notes.$get(
    { param: { id: notebookId }, query: { per_page: String(PER_PAGE), ...(query ? { q: query } : {}) } },
    { init: { signal } },
  );
  if (!response.ok) return { notes: [], truncated: false };
  const payload = (await response.json()) as { data: Array<{ id: string; title: string }>; pagination: { total: number } };
  return {
    notes: payload.data.map((note) => ({ id: note.id, title: note.title })),
    truncated: payload.pagination.total > payload.data.length,
  };
};

/** Build a markdown link string for one note.
 *
 *  Uses the project's internal `note://<shortId>` scheme — the same
 *  format `insertNoteLink` (toolbar) and the markdown-rendering
 *  pipeline produce / parse. Concrete URLs like `/app/notebooks/…`
 *  would bind the link to a specific path layout AND wouldn't be
 *  resolvable across notebooks (a note can be linked from outside
 *  its home notebook context after copy/paste). `note://` keeps
 *  the reference symbolic — the renderer resolves to the right URL
 *  at display time.
 */
const buildMarkdownLink = (note: NoteRef): string => {
  // Escape `]` and `\` in the title since markdown link text uses
  // bracket delimiters. Most titles won't contain these, but we
  // handle them for safety.
  const escapedTitle = note.title.replace(/\\/g, "\\\\").replace(/]/g, "\\]");
  return `[${escapedTitle}](note://${note.id})`;
};

/** Build the Completion list. Sorts by title alphabetically — for
 *  picker UX this beats sorting by recency since users typically
 *  remember the title they're trying to link.
 *
 *  `triggerStart` is the doc position of the opening `[[` (= our
 *  `word.from`). The apply function uses it to REPLACE the entire
 *  `[[…` trigger sequence with the markdown link — without this,
 *  CM would only replace from `result.from` (after the brackets)
 *  to the cursor, leaving the typed `[[` stuck before the inserted
 *  link (observed bug: `[[[Title](…))`). */
/** Non-selectable hint surfaced at the bottom of the popup when
 *  more notes match than one page shows. `apply` is a no-op
 *  (closes the popup without inserting anything); a negative
 *  `boost` keeps it pinned to the bottom regardless of how the
 *  user's typing reranks the rest. */
const truncationHint: Completion = {
  label: "… more notes available — keep typing to filter",
  type: "text",
  boost: -99,
  apply: (view, completion, _from, _to) => {
    // Close popup; do not modify the doc. The user can then keep
    // typing the title to narrow the matches.
    view.dispatch({ annotations: pickedCompletion.of(completion), userEvent: "input.complete" });
  },
};

const buildCompletions = (notes: NoteRef[], triggerStart: number, truncated: boolean): Completion[] => {
  const out = notes
    .slice()
    .sort((a, b) => a.title.localeCompare(b.title))
    .map((n) => {
      const linkText = buildMarkdownLink(n);
      const c: Completion = {
        // `label` is the title — used for filtering against typed
        // text AND for popup display. The popup user sees clean
        // titles, the filter matches typed prefix.
        label: n.title,
        type: "namespace",
        detail: n.id,
        // Apply as a function so we can dispatch a change range
        // that INCLUDES the leading `[[`. `to` is the doc position
        // CM gives us (end of the matched word range, = cursor or
        // a stale cursor if the user typed more since the popup
        // opened). pickedCompletion annotation tells CM to tear
        // the popup down cleanly.
        apply: (view, completion, _from, to) => {
          // Consume a trailing `]]` if CodeMirror's bracket-pair
          // extension auto-closed the trigger. Without this the
          // doc ends up as `[…](note://…)]]` — observed bug. We
          // only extend when the next two chars are EXACTLY `]]`,
          // so an unmatched single `]` typed by the user (rare
          // but possible) doesn't get eaten.
          const after = view.state.sliceDoc(to, Math.min(to + 2, view.state.doc.length));
          const consumeTo = after === "]]" ? to + 2 : to;
          // Trailing space so the user can keep typing prose
          // without manually hitting space. Skip when the next
          // char is already whitespace (mid-sentence pick) to
          // avoid double-spaces.
          const charAfter = view.state.sliceDoc(consumeTo, Math.min(consumeTo + 1, view.state.doc.length));
          const insert = charAfter === "" || !/\s/.test(charAfter) ? `${linkText} ` : linkText;
          view.dispatch({
            changes: { from: triggerStart, to: consumeTo, insert },
            // Place caret right after the inserted link (incl. the trailing space).
            selection: { anchor: triggerStart + insert.length },
            annotations: pickedCompletion.of(completion),
            userEvent: "input.complete",
          });
        },
      };
      withIcon(c, "ti-note");
      return c;
    });
  if (truncated) out.push(truncationHint);
  return out;
};

/** Build a result for a given trigger match. Shared by sync + async
 *  paths so the cache-hit case can return without a Promise wrap. */
const buildResult = (word: { from: number; to: number }, data: NotePage): CompletionResult | null => {
  if (data.notes.length === 0) return null;
  return {
    // `from` = right after the `[[`; the apply functions replace the
    // brackets themselves via an explicit dispatch from word.from.
    from: word.from + 2,
    to: word.to,
    options: buildCompletions(data.notes, word.from, data.truncated),
    // The server already matched what was typed; every keystroke asks it again.
    filter: false,
  };
};

/**
 * Factory — closes over the notebookId so the source can hit the
 * right notes endpoint. Mirrors `buildTagCompletionSource`.
 */
export const buildNoteLinkCompletionSource = (notebookId: string): CompletionSource => {
  return (context: CompletionContext): CompletionResult | Promise<CompletionResult | null> | null => {
    // Trigger: `[[` followed by zero or more "title-body" chars.
    // We allow spaces because note titles often have spaces ("My
    // Project Notes"), so the user can type `[[my project` and
    // have it match. We stop at `]` (closing the wikilink) and at
    // `\n` (end of line).
    //
    // matchBefore is anchored to cursor — the `(?:^|\n)` start is
    // NOT used because brackets can appear anywhere mid-line.
    const word = context.matchBefore(/\[\[[^\]\n]*/);
    if (!word) return null;
    // Skip when preceded by `!` — that's the attachment-autocomplete
    // trigger (`![[partial]]` mirrors markdown's image syntax). If
    // we didn't filter here, BOTH sources would fire on `![[…` and
    // CM would merge their option lists into one popup mixing notes
    // and attachments.
    if (word.from > 0) {
      const charBefore = context.state.sliceDoc(word.from - 1, word.from);
      if (charBefore === "!") return null;
    }
    if (isInsideFencedCode(context)) return null;

    // A newer keystroke aborts this request, so only the matches for what is typed now arrive.
    const controller = new AbortController();
    context.addEventListener("abort", () => controller.abort());
    return fetchNotes(notebookId, word.text.slice(2).trim(), controller.signal)
      .then((data) => buildResult(word, data))
      .catch(() => null);
  };
};
