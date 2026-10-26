/**
 * The colors that stand for a person: the tint behind avatar initials, a collaborator's cursor, and the marks and
 * comments a person leaves. The palette leaves out cyan, which means AI, and yellow, which reads as a text highlight.
 * Several people can share a color, so a person's name always appears next to it.
 */
export const PERSON_COLORS = ["#3b82f6", "#6366f1", "#8b5cf6", "#c026d3", "#ec4899", "#e11d48", "#f97316", "#16a34a"] as const;

/** The palette index for a name, the order of the `.k2b-avatar[data-tint]` rules. Surrounding spaces do not count. */
export const personTint = (name: string): number => {
  const trimmed = name.trim();
  let hash = 0;
  for (let index = 0; index < trimmed.length; index++) hash = (hash * 31 + trimmed.charCodeAt(index)) >>> 0;
  return hash % PERSON_COLORS.length;
};

/** A person's color from their display name, the same wherever Cloud shows that person. */
export const personColor = (name: string): string => PERSON_COLORS[personTint(name)]!;
