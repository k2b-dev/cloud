/**
 * The colors that stand for a person: the tint behind avatar initials, a collaborator's cursor, and the marks and
 * comments a person leaves. The palette leaves out plum, which means AI, and yellow, which reads as a text highlight.
 * Several people can share a color, so a person's name always appears next to it.
 */
export const PERSON_COLORS = ["#3b82f6", "#6366f1", "#8b5cf6", "#0891b2", "#0d9488", "#e11d48", "#f97316", "#16a34a"] as const;

/**
 * The palette index for a name, the order of the `.k2b-avatar[data-tint]` rules. Surrounding spaces do not count.
 * The hash's high bits are mixed into its low ones before the index is taken (MurmurHash3's finalizer): taken from the
 * plain hash alone, the index followed only the last bits of the letters, and many names shared a color.
 */
export const personTint = (name: string): number => {
  const trimmed = name.trim();
  let hash = 0;
  for (let index = 0; index < trimmed.length; index++) hash = (Math.imul(hash, 31) + trimmed.charCodeAt(index)) >>> 0;
  hash = Math.imul(hash ^ (hash >>> 16), 0x85ebca6b) >>> 0;
  hash = Math.imul(hash ^ (hash >>> 13), 0xc2b2ae35) >>> 0;
  return ((hash ^ (hash >>> 16)) >>> 0) % PERSON_COLORS.length;
};

/** A person's color from their display name, the same wherever Cloud shows that person. */
export const personColor = (name: string): string => PERSON_COLORS[personTint(name)]!;
