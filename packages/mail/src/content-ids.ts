/** `src="cid:…"` sources in sanitized message HTML, which the sanitizer keeps for inline images. */
export const CID_SOURCE = /\bsrc=(["'])cid:([^"']+)\1/giu;

// Hydration stores a Content-ID without NUL, which Postgres cannot hold, so a `cid:` source that
// encodes one as %00 drops it too.
export const normalizeContentId = (value: string): string => value.replaceAll("\u0000", "").trim().replace(/^<|>$/gu, "").toLowerCase();

export const contentIdFromSource = (rawContentId: string): string => {
  try {
    return normalizeContentId(decodeURIComponent(rawContentId));
  } catch {
    // Malformed percent escapes cannot match a normalized MIME Content-ID.
    return normalizeContentId(rawContentId);
  }
};

export const referencedContentIds = (html: string): string[] => {
  const ids = new Set<string>();
  for (const match of html.matchAll(CID_SOURCE)) {
    const normalized = match[2] ? contentIdFromSource(match[2]) : "";
    if (normalized) ids.add(normalized);
  }
  return [...ids];
};

/** The stored Content-IDs among `contentIds` that `html` shows through a `cid:` source, by the reader's rule. */
export const bodyReferencedContentIds = (html: string | null | undefined, contentIds: readonly (string | null)[]): string[] => {
  if (!html) return [];
  const referenced = new Set(referencedContentIds(html));
  return [...new Set(contentIds.filter((id): id is string => id !== null && referenced.has(normalizeContentId(id))))];
};
