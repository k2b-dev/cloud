/**
 * Inline autocomplete für Attachment-Referenzen via `![[partial]]`.
 *
 * The leading `!` mirrors markdown's image-embed syntax (`![alt](src)`):
 * an image attachment picked from the list inserts as `![filename]
 * (attach://shortId)` (renders inline), a non-image attachment as
 * `[filename](attach://shortId)` (renders as a link). The trigger
 * distinguishes from the regular `[[partial]]` note-link picker.
 *
 * # Caching
 *
 * Same pattern as note-link / tag autocomplete: per-notebook
 * Map<notebookId, …>, 45s TTL, coalesced concurrent fetches, eager
 * warm-up at factory time.
 *
 * # Scope
 *
 * Skip inside fenced code via shared `editor-scope.ts`.
 */
import {
  type Completion,
  type CompletionContext,
  type CompletionResult,
  type CompletionSource,
  pickedCompletion,
} from "@codemirror/autocomplete";
import { formatBytes } from "@k2b/cloud/shared";
import { apiClient } from "@/api/client";
import { createNotebookFetchCache } from "./_lib/notebook-fetch-cache";
import { isInsideFencedCode } from "./editor-scope";
import { withIcon } from "./completion-icon";

/** Lightweight attachment projection — only what the picker needs. */
type AttRef = {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  kind: "image" | "file";
};

const attachmentCache = createNotebookFetchCache<AttRef[]>(
  async (notebookId) => {
    const res = await apiClient[":id"].attachments.$get({ param: { id: notebookId } });
    if (!res.ok) return [];
    const payload = await res.json();
    return payload.map((a) => ({
      id: a.id,
      filename: a.filename,
      mimeType: a.mimeType,
      sizeBytes: a.sizeBytes,
      kind: a.kind,
    }));
  },
  { fallback: [] },
);

/** Pretty byte size — `42 KB`, `3.7 MB`, etc. Used in the option
 *  detail to give the user a sense of file weight before picking. */
/** Markdown for one attachment. Image → embedded markdown image,
 *  non-image → link. Filename is escaped against `]` and `\`. */
const buildAttachmentMarkdown = (a: AttRef): string => {
  const escapedName = a.filename.replace(/\\/g, "\\\\").replace(/]/g, "\\]");
  const url = `attach://${a.id}`;
  const prefix = a.kind === "image" ? "!" : "";
  return `${prefix}[${escapedName}](${url})`;
};

/** Tabler icon per attachment kind. Image attachments use `ti-photo`;
 *  generic files use `ti-paperclip`. Could be smarter (PDF/audio/
 *  video specific icons) but the binary image/file distinction
 *  covers most use cases. */
const iconFor = (a: AttRef): string => (a.kind === "image" ? "ti-photo" : "ti-paperclip");

/** `triggerStart` is the doc position of the leading `!` (=
 *  word.from), used by each option's apply function to replace the
 *  WHOLE `![[…` typed prefix with the markdown — without this CM
 *  would only replace from result.from (after the brackets) and the
 *  user-typed `![[` would stay stuck before the inserted link
 *  (observed bug: `![[![filename](attach://…))`). */
const buildCompletions = (attachments: AttRef[], triggerStart: number): Completion[] => {
  return attachments
    .slice()
    .sort((a, b) => a.filename.localeCompare(b.filename))
    .map((a) => {
      const md = buildAttachmentMarkdown(a);
      const c: Completion = {
        label: a.filename,
        type: "namespace",
        detail: `${a.kind} · ${formatBytes(a.sizeBytes)}`,
        // Apply via explicit dispatch so the change range includes
        // the leading `![[` typed-prefix. See `note-link-autocomplete.ts`
        // for the same pattern + rationale.
        apply: (view, completion, _from, to) => {
          // Consume trailing `]]` left over from bracket-pair
          // auto-close so we don't produce `![…](attach://…)]]`.
          // Same fix as note-link-autocomplete.
          const after = view.state.sliceDoc(to, Math.min(to + 2, view.state.doc.length));
          const consumeTo = after === "]]" ? to + 2 : to;
          // Trailing space so the user can keep typing prose after
          // the inserted pill. Skip when followed by whitespace
          // already (mid-sentence pick) to avoid double-spaces.
          const charAfter = view.state.sliceDoc(consumeTo, Math.min(consumeTo + 1, view.state.doc.length));
          const insert = charAfter === "" || !/\s/.test(charAfter) ? `${md} ` : md;
          view.dispatch({
            changes: { from: triggerStart, to: consumeTo, insert },
            selection: { anchor: triggerStart + insert.length },
            annotations: pickedCompletion.of(completion),
            userEvent: "input.complete",
          });
        },
      };
      withIcon(c, iconFor(a));
      return c;
    });
};

const buildResult = (word: { from: number; to: number }, attachments: AttRef[]): CompletionResult | null => {
  if (attachments.length === 0) return null;
  return {
    // `from` = right after the `![[` so CM's prefix filter matches
    // the typed filename body against option labels. The apply
    // dispatch covers replacing the `![[` chars themselves.
    from: word.from + 3,
    to: word.to,
    options: buildCompletions(attachments, word.from),
    validFor: /^[^\]\n]*$/,
  };
};

/**
 * Factory. Closes over the notebookId so the source can hit the
 * right attachments endpoint.
 */
export const buildAttachmentCompletionSource = (notebookId: string): CompletionSource => {
  void attachmentCache.fetch(notebookId);

  return (context: CompletionContext): CompletionResult | Promise<CompletionResult | null> | null => {
    // Trigger: `![[` optionally followed by filename body. We don't
    // require any chars after the brackets so the popup opens
    // immediately on `![[`.
    const word = context.matchBefore(/!\[\[[^\]\n]*/);
    if (!word) return null;
    if (isInsideFencedCode(context)) return null;

    const fresh = attachmentCache.getFresh(notebookId);
    if (fresh) return buildResult(word, fresh);
    return attachmentCache.fetch(notebookId).then((atts) => buildResult(word, atts));
  };
};
