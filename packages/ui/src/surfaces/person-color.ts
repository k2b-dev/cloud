/**
 * The colors that stand for a person: the tint behind avatar initials, a collaborator's cursor, and the marks and
 * comments a person leaves. Eleven hues in the order of the color wheel, each dark enough for white initials (at least
 * 4.5:1), and each pair apart by a CIEDE2000 of at least 5 also for people with protanopia, deuteranopia or tritanopia
 * (person-color.test.ts checks both). The palette leaves out plum, which means AI, and yellow, which reads as a text
 * highlight. Several people can share a color, so a person's name always appears next to it.
 */
export const PERSON_COLORS = [
  "#dc2626",
  "#9a3412",
  "#4d7c0f",
  "#15803d",
  "#065f46",
  "#0e7490",
  "#075985",
  "#475569",
  "#2563eb",
  "#3730a3",
  "#6d28d9",
] as const;

/** The palette index for a name, the order of the `.k2b-avatar[data-tint]` rules. Surrounding spaces do not count. */
export const personTint = (name: string): number => {
  const trimmed = name.trim();
  let hash = 0;
  for (let index = 0; index < trimmed.length; index++) hash = (hash * 31 + trimmed.charCodeAt(index)) >>> 0;
  return hash % PERSON_COLORS.length;
};

/**
 * The same hues for the dark theme: each is the light hue 45 % towards white, one step for all, so the hues keep their
 * order of lightness. A mark in a person's color (a comment bar, a passage, a dot, a presence swatch) keeps 3:1 on
 * the dark surface with it, and soft initials 4.5:1 on their tint (person-color.test.ts checks both).
 */
export const PERSON_COLORS_DARK = [
  "#ec8888",
  "#c78f7d",
  "#9db77b",
  "#7eb994",
  "#76a799",
  "#7ab3c2",
  "#77a4bc",
  "#9aa2ac",
  "#87a9f4",
  "#918dcc",
  "#af89ea",
] as const;

/**
 * A person's color from their display name, the same wherever Cloud shows that person. It is the fill behind white
 * initials and a collaborator's caret with its white label, so it stays the same in both themes.
 */
export const personColor = (name: string): string => PERSON_COLORS[personTint(name)]!;

/** A person's color for the dark theme (see `PERSON_COLORS_DARK`). */
export const personColorDark = (name: string): string => PERSON_COLORS_DARK[personTint(name)]!;

/**
 * A person's color for a mark drawn on the page (a comment bar, a dot, a swatch): `light-dark()` of both hues, so the
 * mark keeps 3:1 against the surface in either theme. Use it in CSS only, never where a hex is expected.
 */
export const personMarkColor = (name: string): string => personMarkColorOf(personColor(name));

/**
 * The mark color of a stored person color: a hue of `PERSON_COLORS` becomes `light-dark()` of it and its dark step;
 * any other color stays as it is. For contracts that keep the hex (a comment's author color) and draw it in CSS.
 */
export const personMarkColorOf = (color: string): string => {
  const index = PERSON_COLORS.findIndex((hue) => hue === color.trim().toLowerCase());
  return index < 0 ? color : `light-dark(${PERSON_COLORS[index]}, ${PERSON_COLORS_DARK[index]})`;
};
