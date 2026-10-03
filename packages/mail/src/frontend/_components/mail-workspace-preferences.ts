import type { MailListMode } from "../../service/workspace";
import { type MailConversationToolbarActionId, normalizeMailConversationToolbarActions } from "./mail-conversation-toolbar";

export type MailWorkspacePreferences = {
  listCollapsed: boolean;
  detailsOpen: boolean;
  toolbarActions: MailConversationToolbarActionId[];
  listMode: MailListMode;
  lastMailboxId: string | null;
  pinnedMailboxIds: string[];
  /** Mailboxes left out of the overview sidebar and Focus; opening them directly still works. */
  hiddenMailboxIds: string[];
};

const MAIL_WORKSPACE_COOKIE = "cloud_mail_workspace";
const isMailResourceId = (value: unknown): value is string => typeof value === "string" && /^[0-9A-Za-z]{6}$/.test(value);
// Browsers drop a cookie over 4096 bytes, and then no workspace preference saves. An encoded ID
// costs 15 bytes, so the pinned and hidden lists keep their newest 100 each and stay near 3 KB.
const MAX_MAILBOX_IDS = 100;
const normalizeMailboxIds = (value: unknown): string[] =>
  Array.isArray(value) ? [...new Set(value.filter(isMailResourceId))].slice(0, MAX_MAILBOX_IDS) : [];

const normalizeMailWorkspacePreferences = (value: unknown): MailWorkspacePreferences => ({
  listCollapsed: Boolean(value && typeof value === "object" && (value as { listCollapsed?: unknown }).listCollapsed === true),
  detailsOpen: Boolean(value && typeof value === "object" && (value as { detailsOpen?: unknown }).detailsOpen === true),
  toolbarActions: normalizeMailConversationToolbarActions(
    value && typeof value === "object" ? (value as { toolbarActions?: unknown }).toolbarActions : undefined,
  ),
  listMode: value && typeof value === "object" && (value as { listMode?: unknown }).listMode === "messages" ? "messages" : "conversations",
  lastMailboxId:
    value && typeof value === "object" && isMailResourceId((value as { lastMailboxId?: unknown }).lastMailboxId)
      ? (value as { lastMailboxId: string }).lastMailboxId
      : null,
  pinnedMailboxIds: normalizeMailboxIds(
    value && typeof value === "object" ? (value as { pinnedMailboxIds?: unknown }).pinnedMailboxIds : undefined,
  ),
  hiddenMailboxIds: normalizeMailboxIds(
    value && typeof value === "object" ? (value as { hiddenMailboxIds?: unknown }).hiddenMailboxIds : undefined,
  ),
});

export const readMailWorkspacePreferences = (cookieHeader: string | null | undefined): MailWorkspacePreferences => {
  const encoded = cookieHeader
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${MAIL_WORKSPACE_COOKIE}=`))
    ?.slice(MAIL_WORKSPACE_COOKIE.length + 1);
  if (!encoded) return normalizeMailWorkspacePreferences(null);
  try {
    return normalizeMailWorkspacePreferences(JSON.parse(decodeURIComponent(encoded)));
  } catch {
    return normalizeMailWorkspacePreferences(null);
  }
};

/** Returns the preferences as stored, so a list past its limit shows what a reload will show. */
export const writeMailWorkspacePreferences = (preferences: MailWorkspacePreferences): MailWorkspacePreferences => {
  const normalized = normalizeMailWorkspacePreferences(preferences);
  document.cookie = `${MAIL_WORKSPACE_COOKIE}=${encodeURIComponent(
    JSON.stringify(normalized),
  )}; Path=/app/mail; Max-Age=31536000; SameSite=Lax`;
  return normalized;
};

/**
 * Changes only the given preferences on top of the stored cookie. A document
 * restored from history may render older preferences; writing them back whole
 * would overwrite what a newer document has saved since.
 */
export const updateMailWorkspacePreferences = (patch: Partial<MailWorkspacePreferences>): void => {
  writeMailWorkspacePreferences({ ...readMailWorkspacePreferences(document.cookie), ...patch });
};
