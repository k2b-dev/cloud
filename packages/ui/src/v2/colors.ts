/**
 * Data colours (a base, a tag, a person, a kind of thing) come from data, so a primitive validates one before it puts
 * it into a style, on the server and in the browser alike: a hex colour, an `oklch()` of plain numbers, or a custom
 * property of the page (`var(--name)`). Anything else is dropped and the primitive stays neutral.
 */

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const NUMBER = String.raw`(?:\d+(?:\.\d+)?|\.\d+)`;
const OKLCH = new RegExp(String.raw`^oklch\(\s*${NUMBER}%?\s+${NUMBER}%?\s+${NUMBER}(?:deg)?\s*(?:\/\s*${NUMBER}%?\s*)?\)$`, "i");
const TOKEN = /^var\(--[a-z0-9][a-z0-9-]*\)$/i;

/** The colour when it has one of the accepted forms, else nothing. */
export const safeColor = (value: string | undefined): string | undefined => {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return HEX.test(trimmed) || OKLCH.test(trimmed) || TOKEN.test(trimmed) ? trimmed : undefined;
};

/** A value for a custom property that cannot end its declaration or open another one. */
export const safeValue = (value: string) => !/[;{}<>\\]/.test(value);
