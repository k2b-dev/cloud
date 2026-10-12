import { chatMessages } from "../messages";

export const TITLE_NAME_LIMIT = 3;
/** Members here exclude the caller and are already in stable membership order. */
export const deriveTitle = (name: string | null, others: { displayName: string; givenName: string }[], locale?: string): string => {
  if (name) return name;
  const { t } = chatMessages.resolve(locale ? [locale] : []);
  if (others.length === 0) return t.you;
  if (others.length === 1) return others[0]!.displayName;
  const names = others
    .slice(0, TITLE_NAME_LIMIT)
    .map((member) => member.givenName.trim() || member.displayName.trim().split(/\s+/)[0] || member.displayName);
  return [...names, ...(others.length > TITLE_NAME_LIMIT ? [t.moreNames] : [])].join(", ");
};
