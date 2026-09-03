/**
 * Autocomplete für `#tag` Referenzen im Notebook.
 *
 * Trigger: cursor sits right after a `#<partial>` sequence anywhere
 * mid-text. Prefixes like `#t` open immediately. A bare `#` opens
 * after a short delay so quick heading input (`# `) stays quiet.
 * Suggestions are the existing tags in the current notebook, pulled from
 * `/api/notebooks/:id/tags` — the same endpoint `nb.tags.list()`
 * uses, so the autocomplete reflects exactly what the rest of the
 * app sees.
 *
 * # Why delay bare "#"
 *
 * `#` alone is ambiguous: at line start it could become a heading
 * (` # Heading`), mid-line it could be the start of a tag, or it
 * could just be a literal hash character. Delaying only the bare
 * hash keeps `#tag` autocomplete instant while avoiding noisy popups
 * when the user is typing a heading.
 *
 * # Server-tag cache
 *
 * Fetching every keystroke would hammer the API. We cache the tag
 * list per notebook with a short TTL — typing rapidly only hits
 * the network once, subsequent triggers reuse the cached list. The
 * TTL is short enough (45s) that tags added in other tabs / by
 * other collaborators show up within a minute without manual
 * refresh.
 *
 * # Scope
 *
 * Skip inside FencedCode blocks — `#` in code is just literal text
 * (CSS selectors, shell comments, Python decorators, etc.), and
 * surfacing tag suggestions there would be confusing.
 */
import {
  type Completion,
  type CompletionContext,
  type CompletionResult,
  type CompletionSource,
  pickedCompletion,
} from "@codemirror/autocomplete";
import { apiClient } from "@/api/client";
import { createNotebookFetchCache } from "./_lib/notebook-fetch-cache";
import { isInsideFencedCode } from "./editor-scope";
import { withIcon } from "./completion-icon";

/** Notebook tag-search response shape. */
type TagSummary = { tag: string; count: number };

type CachedTags = { tags: TagSummary[] };

const EMPTY_CACHED: CachedTags = { tags: [] };
const BARE_HASH_DELAY_MS = 500;

const tagCache = createNotebookFetchCache<CachedTags>(
  async (notebookId) => {
    const res = await apiClient[":id"].tags.$get({ param: { id: notebookId } });
    if (!res.ok) return EMPTY_CACHED;
    const tags = await res.json();
    return { tags };
  },
  { fallback: EMPTY_CACHED },
);

/** Build the Completion list from server data. Pre-format the
 *  `detail` so we don't re-allocate strings on every keystroke
 *  inside the popup filter. */
const buildCompletions = (tags: TagSummary[]): Completion[] => {
  return tags
    .slice()
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
    .map((t) => {
      // Custom `apply` to (a) append a trailing space so the user
      // can keep typing prose without manually hitting space, and
      // (b) skip that space when the next char is already
      // whitespace so we don't produce double-spaces mid-sentence.
      // The result's `from` is anchored AFTER the `#` the user
      // already typed, so inserting just the tag body (no leading
      // `#`) produces the correct `#tag` result. (Earlier revision
      // shipped `apply: \`#${t.tag}\`` which double-inserted the
      // hash → `##tag`.)
      const c: Completion = {
        label: t.tag,
        type: "constant",
        detail: t.count === 1 ? "1 note" : `${t.count} notes`,
        apply: (view, completion, from, to) => {
          const charAfter = view.state.sliceDoc(to, Math.min(to + 1, view.state.doc.length));
          const insert = charAfter === "" || !/\s/.test(charAfter) ? `${t.tag} ` : t.tag;
          view.dispatch({
            changes: { from, to, insert },
            selection: { anchor: from + insert.length },
            annotations: pickedCompletion.of(completion),
            userEvent: "input.complete",
          });
        },
      };
      withIcon(c, "ti-hash");
      return c;
    });
};

const LOCAL_TAG_REGEX = /(?:^|\s)#([a-zA-Z][\w-]*(?:\/[\w-]+)*)/g;

const extractLocalTags = (context: CompletionContext, activeWord: { from: number; to: number }): TagSummary[] => {
  const counts = new Map<string, number>();
  const text = context.state.doc.toString();

  for (const match of text.matchAll(LOCAL_TAG_REGEX)) {
    const matchStart = match.index!;
    const leadingLen = match[0]!.length - `#${match[1]!}`.length;
    const from = matchStart + leadingLen;
    const to = from + 1 + match[1]!.length;

    // Do not turn the currently typed partial tag into a suggestion.
    // `#t` should suggest existing tags, not create a noisy `t` option
    // from the active word itself.
    if (from === activeWord.from && to === activeWord.to) continue;

    const tag = match[1]!.toLowerCase();
    counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }

  return Array.from(counts, ([tag, count]) => ({ tag, count }));
};

const mergeTags = (serverTags: TagSummary[], localTags: TagSummary[]): TagSummary[] => {
  const counts = new Map<string, number>();
  for (const tag of serverTags) counts.set(tag.tag, tag.count);
  for (const tag of localTags) counts.set(tag.tag, Math.max(counts.get(tag.tag) ?? 0, tag.count));
  return Array.from(counts, ([tag, count]) => ({ tag, count }));
};

const delayBareHash = (context: CompletionContext): Promise<boolean> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return new Promise((resolve) => {
    const done = (value: boolean) => {
      if (timer) clearTimeout(timer);
      resolve(value);
    };
    context.addEventListener("abort", () => done(false), { onDocChange: true });
    timer = setTimeout(() => done(!context.aborted), BARE_HASH_DELAY_MS);
  });
};

const isLineStartHash = (context: CompletionContext, word: { from: number }): boolean =>
  context.state.doc.lineAt(word.from).from === word.from;

/** Result-builder shared by sync + async branches. Pulls `from`
 *  one past the `#` so CM filters by tag body, not by the literal
 *  `#`-prefixed string. */
const buildResult = (word: { from: number; to: number }, context: CompletionContext, serverTags: TagSummary[]): CompletionResult | null => {
  const completions = buildCompletions(mergeTags(serverTags, extractLocalTags(context, word)));
  if (completions.length === 0) return null;
  return {
    from: word.from + 1,
    to: word.to,
    options: completions,
    // Keep the popup open while the user is still typing word
    // chars. As soon as they type whitespace / punctuation /
    // anything non-word, the popup closes (correct — the tag is
    // committed at that point).
    validFor: /^\w*$/,
  };
};

/**
 * Factory — closes over the notebookId so the source can hit the
 * right tag endpoint. Mirrors `buildSlashSource(ctx)` so the wiring
 * in `slash-commands/index.ts` stays uniform.
 *
 * # Sync-when-cached pattern
 *
 * Earlier revision was `async (context) => ...` which made EVERY
 * invocation return a Promise even when it just did
 * `matchBefore` + early `return null`. CM autocomplete waits for
 * pending source promises before opening the popup — so an
 * unconditionally-async source delays the OTHER (sync) sources'
 * popups by one microtask per keystroke. Multiplied across all
 * non-matching keystrokes that's visible lag.
 *
 * The fix: stay synchronous on the hot path (no match, in code,
 * cache miss → null). Only return a Promise when we actually need
 * to await the fetch — i.e. cold cache AND the user is in `#word`
 * context. Once the cache is warm (after the first fetch), every
 * subsequent invocation is sync.
 *
 * We also kick off a background fetch in the factory itself so
 * by the time the user types their first `#`, the cache is usually
 * already populated.
 */
export const buildTagCompletionSource = (notebookId: string): CompletionSource => {
  // Warm the cache early — most editors will have completed this
  // fetch before the user types their first `#`. No await: we don't
  // care about the result here, just the side effect of populating
  // the cache.
  void tagCache.fetch(notebookId);

  return (context: CompletionContext): CompletionResult | Promise<CompletionResult | null> | null => {
    // Three trigger modes:
    //
    // - IMPLICIT prefix: `#\w+` opens immediately.
    // - IMPLICIT bare hash: inline `#` opens immediately; line-start
    //   `#` opens after a small delay. If the user keeps typing a
    //   heading (`# `), CM aborts the async query on doc change before
    //   it can show.
    //
    // - EXPLICIT trigger (user invoked completion via Ctrl-Space
    //   or our `/tag` slash command, which calls startCompletion
    //   programmatically): allow bare `#` so the entire tag list
    //   surfaces immediately. CM sets `context.explicit = true`
    //   for these invocations.
    //
    // matchBefore does NOT use `^` so this fires mid-line as well
    // as at line start. The string `hello #pr` matches with
    // `from` at the `#` position (index 6), surfacing tag
    // suggestions exactly the same way as a line-start `#pr`.
    const word = context.matchBefore(context.explicit ? /#\w*/ : /#\w+/) ?? context.matchBefore(/#/);
    if (!word) return null;
    if (isInsideFencedCode(context)) return null;
    // Align with `extractTags` semantics: the `#` must be preceded
    // by whitespace OR be at the very start of the document. This
    // matches what the tag-indexer treats as a tag — `abc#foo` in
    // mid-word is just literal text, not a tag, so the autocomplete
    // shouldn't fire there either.
    if (word.from > 0) {
      const prev = context.state.sliceDoc(word.from - 1, word.from);
      if (!/\s/.test(prev)) return null;
    }

    const fresh = tagCache.getFresh(notebookId);
    if (fresh) {
      // Cache hit — fully synchronous path. No microtask, no
      // Promise allocation. We still merge in local editor tags so
      // freshly typed tags become suggestions before the server
      // reindex + cache TTL cycle catches up.
      const result = buildResult(word, context, fresh.tags);
      if (word.text !== "#" || context.explicit || !result || !isLineStartHash(context, word)) return result;
      return delayBareHash(context).then((ok) => (ok ? result : null));
    }

    // Cold/stale cache — return a Promise. CM handles it gracefully
    // (popup may briefly delay opening or update once data lands).
    return tagCache.fetch(notebookId).then(async (data) => {
      const result = buildResult(word, context, data.tags);
      if (word.text !== "#" || context.explicit || !result || !isLineStartHash(context, word)) return result;
      return (await delayBareHash(context)) ? result : null;
    });
  };
};
