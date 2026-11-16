/**
 * The range of the first place in `root`'s text where `text` occurs, ignoring whitespace, so a passage copied from a
 * selection across lines, paragraphs or list items still finds its words. Returns nothing when it does not occur.
 */
export const findTextRange = (root: Node, text: string): Range | null => {
  const needle = text.normalize("NFC").replace(/\s+/gu, "");
  if (!needle) return null;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const chars: string[] = [];
  const places: [Text, number][] = [];
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    const value = node.data.normalize("NFC");
    // Composed and decomposed text map to the same places only when normalizing keeps its length.
    if (value.length !== node.data.length) continue;
    for (let offset = 0; offset < value.length; offset++) {
      if (/\s/u.test(value[offset]!)) continue;
      chars.push(value[offset]!);
      places.push([node, offset]);
    }
  }
  const at = chars.join("").indexOf(needle);
  if (at < 0) return null;
  const [startNode, startOffset] = places[at]!;
  const [endNode, endOffset] = places[at + needle.length - 1]!;
  const range = document.createRange();
  range.setStart(startNode, startOffset);
  range.setEnd(endNode, endOffset + 1);
  return range;
};

/**
 * Tints the passage `text` in `root` with the CSS highlight `name` and returns what removes it, or nothing where the
 * passage is missing or the browser has no CSS Custom Highlight API.
 */
export const highlightTextPassage = (root: Node, text: string, name: string): (() => void) | null => {
  if (typeof CSS === "undefined" || !("highlights" in CSS) || typeof Highlight === "undefined") return null;
  // Names, times and quotes around the text are no passage when the item marks its text.
  const scopes = root instanceof Element ? [...root.querySelectorAll("[data-k2b-passage]")] : [];
  const range = scopes.length ? (scopes.map((scope) => findTextRange(scope, text)).find(Boolean) ?? null) : findTextRange(root, text);
  if (!range) return null;
  const highlight = new Highlight(range);
  CSS.highlights.set(name, highlight);
  return () => {
    if (CSS.highlights.get(name) === highlight) CSS.highlights.delete(name);
  };
};
