/**
 * The colors that stand for a person: the tint behind avatar initials, a collaborator's cursor, and the marks and
 * comments a person leaves. Eleven hues in the order of the color wheel, each dark enough for white initials (at least
 * 4.5:1), and each pair apart by a CIEDE2000 of at least 5 also for people with protanopia, deuteranopia or tritanopia
 * (person-color.test.ts checks both). The palette leaves out plum, which means AI, and yellow, which reads as a text
 * highlight. Several people can share a color, so a person's name always appears next to it.
 */
export const PERSON_COLORS = ["#dc2626", "#9a3412", "#4d7c0f", "#15803d", "#065f46", "#0e7490", "#075985", "#475569", "#2563eb", "#3730a3", "#6d28d9"] as const;

/** The palette index for a name, the order of the `.k2b-avatar[data-tint]` rules. Surrounding spaces do not count. */
export const personTint = (name: string): number => {
  const trimmed = name.trim();
  let hash = 0;
  for (let index = 0; index < trimmed.length; index++) hash = (hash * 31 + trimmed.charCodeAt(index)) >>> 0;
  return hash % PERSON_COLORS.length;
};

/** A person's color from their display name, the same wherever Cloud shows that person. */
export const personColor = (name: string): string => PERSON_COLORS[personTint(name)]!;
