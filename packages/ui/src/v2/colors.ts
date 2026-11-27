/**
 * Data colours (a base, a tag, a person, a kind of thing) come from data, so a primitive validates one before it puts
 * it into a style, on the server and in the browser alike: a hex colour, an `oklch()` of plain numbers, a custom
 * property of the page (`var(--name)`), or `light-dark(a, b)` of two such colours, so a colour can keep its contrast in
 * both themes. Anything else is dropped and the primitive stays neutral.
 */

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const NUMBER = String.raw`(?:\d+(?:\.\d+)?|\.\d+)`;
const OKLCH = new RegExp(String.raw`^oklch\(\s*${NUMBER}%?\s+${NUMBER}%?\s+${NUMBER}(?:deg)?\s*(?:\/\s*${NUMBER}%?\s*)?\)$`, "i");
const TOKEN = /^var\(--[a-z0-9][a-z0-9-]*\)$/i;
/** `light-dark(` … `)` around exactly one top-level comma; both sides are checked as colours of their own. */
const LIGHT_DARK = /^light-dark\((.*)\)$/i;

const plainColor = (value: string) => HEX.test(value) || OKLCH.test(value) || TOKEN.test(value);

/** The two sides of a `light-dark()`, split at its one comma outside parentheses; nothing when there is not exactly one. */
const sides = (inner: string): [string, string] | undefined => {
  let depth = 0;
  let at = -1;
  for (let index = 0; index < inner.length; index++) {
    const sign = inner[index];
    if (sign === "(") depth++;
    else if (sign === ")") depth--;
    else if (sign === "," && depth === 0) {
      if (at !== -1) return undefined;
      at = index;
    }
    if (depth < 0) return undefined;
  }
  return depth === 0 && at !== -1 ? [inner.slice(0, at).trim(), inner.slice(at + 1).trim()] : undefined;
};

/** The colour when it has one of the accepted forms, else nothing. */
export const safeColor = (value: string | undefined): string | undefined => {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (plainColor(trimmed)) return trimmed;
  // a colour for each theme: both sides must be plain colours themselves (no nesting, nothing else)
  const both = LIGHT_DARK.exec(trimmed)?.[1];
  const pair = both === undefined ? undefined : sides(both);
  return pair && plainColor(pair[0]) && plainColor(pair[1]) ? `light-dark(${pair[0]}, ${pair[1]})` : undefined;
};

/** A value for a custom property that cannot end its declaration or open another one. */
export const safeValue = (value: string) => !/[;{}<>\\]/.test(value);
