import { VENUE_SLUG_MAX_LENGTH, VENUE_SLUG_MIN_LENGTH, VENUE_SLUG_PATTERN } from "../contracts";
import type { VenueMessages } from "../messages";

/** A slug suggestion from a name: `Campus-Café Nord` becomes `campus-cafe-nord`. */
export const slugFromName = (value: string): string =>
  value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/ß/g, "ss")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, VENUE_SLUG_MAX_LENGTH)
    .replace(/-+$/g, "");

/** Why a slug cannot be saved, or `undefined` when it can. The server applies the same rule. */
export const venueSlugError = (slug: string, t: VenueMessages): string | undefined => {
  const value = slug.trim();
  if (!value) return t.slugRequired;
  if (value.length < VENUE_SLUG_MIN_LENGTH || value.length > VENUE_SLUG_MAX_LENGTH || !VENUE_SLUG_PATTERN.test(value)) {
    return t.slugInvalid;
  }
  return undefined;
};
