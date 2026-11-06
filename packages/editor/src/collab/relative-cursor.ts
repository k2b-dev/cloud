import * as Y from "yjs";

/** Resolve only the already mounted text root; Yjs may create unknown named roots. */
export const resolveTextCursor = (ytext: Y.Text, value: unknown): Y.AbsolutePosition | null => {
  const doc = ytext.doc;
  if (!doc) return null;
  try {
    const position = Y.createRelativePositionFromJSON(value);
    if (typeof position.tname !== "string" || position.type !== null) return null;
    const root = doc.share.get(position.tname);
    if (!(root instanceof Y.Text) || root !== ytext) return null;
    const absolute = Y.createAbsolutePositionFromRelativePosition(position, doc);
    return absolute?.type === ytext ? absolute : null;
  } catch {
    // Pending references and malformed transient cursor states have no position.
    return null;
  }
};
