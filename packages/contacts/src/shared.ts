type NameLike = {
  label?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  companyName?: string | null;
  emails?: Array<{ email: string }> | null;
  phones?: Array<{ phone: string }> | null;
};

const trimOrNull = (value: string | null | undefined): string | null => {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
};

export const resolveContactName = (contact: NameLike, unnamedFallback = "Unnamed contact"): string => {
  const fullName = [trimOrNull(contact.firstName), trimOrNull(contact.lastName)].filter(Boolean).join(" ");
  return (
    trimOrNull(contact.label) ??
    trimOrNull(fullName) ??
    trimOrNull(contact.companyName) ??
    trimOrNull(contact.emails?.[0]?.email) ??
    trimOrNull(contact.phones?.[0]?.phone) ??
    unnamedFallback
  );
};

export const resolveStoredContactLabel = (contact: NameLike): string | null => {
  return trimOrNull(contact.label);
};

export const resolveContactInitials = (contact: NameLike): string => {
  const nameParts = [trimOrNull(contact.firstName), trimOrNull(contact.lastName)].filter(Boolean) as string[];
  if (nameParts.length > 0)
    return nameParts
      .slice(0, 2)
      .map((part) => part.charAt(0).toUpperCase())
      .join("");
  return resolveContactName(contact).slice(0, 2).toUpperCase();
};

export const safeWebsiteHref = (value: string): string | null => {
  const trimmed = value.trim();
  try {
    const url = new URL(trimmed);
    return url.protocol === "http:" || url.protocol === "https:" ? trimmed : null;
  } catch {
    return null;
  }
};

export const isSafeWebsiteUrl = (value: string): boolean => safeWebsiteHref(value) !== null;

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

export const safeTagColor = (value: string): string => (HEX_COLOR.test(value) ? value : "#6b7280");
