/**
 * The measured numbers of @k2b/ui v2, taken from the approved mockup (`v2.css`, draft 16). `v2.css` declares the same
 * values as custom properties; a unit test keeps both in step, and the layout measurements in the browser tests read
 * their limits from here.
 */

/** The four type roles. A primitive picks a role, never a size. */
export const typeRoles = {
  /** Labels, times, counters. */
  meta: { size: 12, lineHeight: 16, weight: 400 },
  /** Rows and controls. */
  row: { size: 13, lineHeight: 20, weight: 400 },
  /** Titles in a head, reading text. */
  body: { size: 14, lineHeight: 20, weight: 400 },
  /** The one main statement or name. */
  lead: { size: 18, lineHeight: 24, weight: 600 },
} as const;

export type TypeRole = keyof typeof typeRoles;

/** The three weights; emphasis is a weight, never a size. */
export const fontWeights = [400, 500, 600] as const;

/**
 * Where text starts in a column: 20 px from 768 px, 16 px below. After an icon the text edge is 24 px further in
 * (16 px icon and 8 px gap), so 44 px and 40 px on the phone.
 */
export const textEdge = { wide: 20, phone: 16, afterIcon: 24, phoneBelow: 768 } as const;

/** The one hairline: 1 px in one colour. Lines separate groups and reach the edges of their column. */
export const hairline = { width: 1 } as const;

/** Radii by role: a mark (4), a control or an overlay (8), round (999), the app card (14). Structure is square. */
export const radii = { mark: 4, control: 8, overlay: 8, round: 999, card: 14 } as const;

/**
 * Fixed heights by place; a primitive takes its height from where it stands. The row heights are minima, as in the
 * mockup: a row of two or three lines is taller than its minimum by its line, so it stands 53 and 73 px apart
 * (`row2 + hairline.width`), exactly as the approved mockup renders it.
 */
export const heights = {
  head: 56,
  status: 52,
  tabs: 44,
  bar: 40,
  columns: 36,
  row: 40,
  row2: 52,
  row3: 72,
  dense: 32,
  control: 36,
  controlSmall: 28,
} as const;

/** A grip's pill centre lies on the centre of its line within this many CSS px, at device pixel ratio 1 and 2. */
export const gripTolerance = 0.25;
