import * as Y from "yjs";

/** Capture an existing character, never a boundary that could drift to a neighbour. */
export const captureTextAnchor = (text: Y.Text, index: number): Uint8Array => {
  if (!text.doc || !Number.isSafeInteger(index) || index < 0 || index >= text.length)
    throw new RangeError("A text anchor must identify an existing character in an attached Y.Text");
  return Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(text, index, 0));
};

/**
 * Resolve only the original live character. Ordinary relative positions also
 * resolve beside deleted characters and follow undo replacements; neither is
 * a safe target for a delayed structural action.
 */
export const resolveTextAnchor = (text: Y.Text, bytes: Uint8Array): number | null => {
  if (!text.doc) return null;
  try {
    const anchor = Y.decodeRelativePosition(bytes);
    if (!anchor.item || anchor.assoc !== 0) return null;
    const position = Y.createAbsolutePositionFromRelativePosition(anchor, text.doc, false);
    if (!position || position.type !== text || position.index < 0 || position.index >= text.length) return null;
    // Item encodings omit the root type name. Compare two decoded positions,
    // rather than a decoded anchor with a fresh position containing that name.
    const live = Y.decodeRelativePosition(captureTextAnchor(text, position.index));
    return Y.compareRelativePositions(anchor, live) ? position.index : null;
  } catch {
    return null;
  }
};
