/**
 * Shared scope helpers for completion sources.
 *
 * All sources that need to know "is the cursor inside a fenced code
 * block?" go through here. Without this helper, each source would
 * walk the syntax tree independently — multiplied across the 3-4
 * completion sources that share this question, that's a lot of
 * redundant work per keystroke.
 *
 * Cache strategy: keyed on the immutable `EditorState` object and
 * the cursor position. CM6 gives us a fresh `EditorState` per
 * transaction, so the WeakMap entry naturally lives only as long
 * as the state is reachable — no manual eviction needed. Multiple
 * sources running in the same transaction (= same state) hit the
 * cache; the first one pays for the syntax-tree walk, the rest are
 * O(1).
 */
import type { CompletionContext } from "@codemirror/autocomplete";
import { syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";

type CacheEntry = {
  /** Cursor position the cached answer is valid at. Different
   *  positions within the same state can resolve to different
   *  nodes (e.g. one on the opening fence line, one in the body),
   *  so we key by both. */
  pos: number;
  /** True iff cursor is inside any FencedCode node. */
  insideFence: boolean;
  /** True iff cursor is inside the BODY (or closing line) of a
   *  FencedCode — i.e. anywhere in the fence range EXCEPT the
   *  opening line. Used by the code-fence-snippets picker, which
   *  should fire ON the opening line (that IS the trigger position)
   *  but stay silent inside the body or on the closing line. */
  insideFenceBody: boolean;
};

const cache = new WeakMap<EditorState, CacheEntry>();

const computeEntry = (context: CompletionContext): CacheEntry => {
  const tree = syntaxTree(context.state);
  let node = tree.resolveInner(context.pos, -1);
  let fenceNode: typeof node | null = null;
  while (node) {
    if (node.name === "FencedCode" || node.name === "CodeBlock") {
      fenceNode = node;
      break;
    }
    if (!node.parent) break;
    node = node.parent;
  }
  if (!fenceNode) return { pos: context.pos, insideFence: false, insideFenceBody: false };
  // "Body" check: skip when the cursor line is the FENCE OPENING
  // line. Compute by lineAt — fenceNode.from is the position of the
  // opening backticks/tildes, so the line at that position is the
  // opener.
  const cursorLine = context.state.doc.lineAt(context.pos);
  const openerLine = context.state.doc.lineAt(fenceNode.from);
  return {
    pos: context.pos,
    insideFence: true,
    insideFenceBody: cursorLine.from !== openerLine.from,
  };
};

const getEntry = (context: CompletionContext): CacheEntry => {
  const cached = cache.get(context.state);
  if (cached && cached.pos === context.pos) return cached;
  const entry = computeEntry(context);
  cache.set(context.state, entry);
  return entry;
};

/**
 * True when the cursor is inside any FencedCode / CodeBlock node.
 *
 * Used by notice-card + tag sources — they're literal-text inside a
 * code fence and shouldn't surface suggestions there.
 */
export const isInsideFencedCode = (context: CompletionContext): boolean => getEntry(context).insideFence;

/**
 * True when the cursor is inside the BODY (not the opener line) of
 * a FencedCode. Used by the code-fence-snippets picker: typing
 * ` ``` ` on the OPENER should surface the language list, but typing
 * ` ``` ` on the CLOSING line shouldn't (the user is closing an
 * existing fence, not starting a new one).
 *
 * Returns false when the cursor is not inside any fence (i.e. plain
 * markdown context).
 */
export const isInsideFencedCodeBody = (context: CompletionContext): boolean => getEntry(context).insideFenceBody;
