import { parsePhoneNumberFromString } from "libphonenumber-js/min";

/**
 * A stored phone number written for reading, such as `+49 30 12345678` for `+493012345678`, by the international
 * rules of its country. Only the server uses it, so no page script carries the number metadata. A number that cannot
 * be read as one shows as stored.
 */
export const formatPhone = (stored: string): string => {
  const parsed = parsePhoneNumberFromString(stored.trim());
  return parsed?.isPossible() ? parsed.formatInternational() : stored;
};
