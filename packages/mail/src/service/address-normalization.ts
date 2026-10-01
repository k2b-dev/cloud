import { domainToASCII } from "node:url";

export const normalizeEmailDomain = (value: string): string | null => {
  const trimmed = value.trim().replace(/\.$/u, "").toLowerCase();
  if (!trimmed || trimmed.length > 253 || trimmed.includes("@")) return null;
  const ascii = domainToASCII(trimmed);
  if (
    !ascii ||
    ascii.length > 253 ||
    ascii.split(".").some((label) => label.length < 1 || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label))
  ) {
    return null;
  }
  return ascii;
};

/**
 * Whether `mail.message_addresses.email` can hold the value: 3 to 320 characters, counted
 * as Postgres counts them (code points). A provider can report any header text as an
 * envelope address, such as an HTML fragment in a spam `To:` header.
 */
export const isStorableMessageAddress = (value: string): boolean => {
  const length = [...value].length;
  return length >= 3 && length <= 320;
};

export const normalizeEmailAddress = (value: string): string | null => {
  const normalized = value.trim().toLowerCase();
  const separator = normalized.lastIndexOf("@");
  if (normalized.length < 3 || normalized.length > 320 || separator < 1 || separator === normalized.length - 1 || /\s/u.test(normalized)) {
    return null;
  }
  const domain = normalizeEmailDomain(normalized.slice(separator + 1));
  return domain ? `${normalized.slice(0, separator)}@${domain}` : null;
};
