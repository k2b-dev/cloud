export const MAIL_USER_PREFERENCES_COOKIE = "settings-app-mail";

export type MailReadingFormat = "automatic" | "html" | "plain";

export type MailUserPreferences = {
  composeFormat: "markdown" | "plain";
  readingFormat: MailReadingFormat;
  undoSeconds: number;
  /** Folders whose "only in the folder" hint this person dismissed in the views that mix folders. */
  dismissedFolderHints: string[];
};

export type StoredMailUserPreferences = {
  mailboxes: Record<string, unknown>;
};

const DEFAULT_MAIL_USER_PREFERENCES: MailUserPreferences = {
  composeFormat: "markdown",
  readingFormat: "automatic",
  undoSeconds: 20,
  dismissedFolderHints: [],
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

export const normalizeMailUserPreferences = (value: unknown): MailUserPreferences => {
  const record = asRecord(value);
  const readingFormat = record?.readingFormat;
  const undoSeconds = record?.undoSeconds;
  const dismissedFolderHints = record?.dismissedFolderHints;
  return {
    composeFormat: record?.composeFormat === "plain" ? "plain" : "markdown",
    readingFormat: readingFormat === "html" || readingFormat === "plain" ? readingFormat : "automatic",
    undoSeconds:
      typeof undoSeconds === "number" && Number.isInteger(undoSeconds)
        ? Math.min(Math.max(undoSeconds, 0), 60)
        : DEFAULT_MAIL_USER_PREFERENCES.undoSeconds,
    dismissedFolderHints: Array.isArray(dismissedFolderHints)
      ? [...new Set(dismissedFolderHints.filter((folderId): folderId is string => typeof folderId === "string"))]
      : [],
  };
};

export const readStoredMailUserPreferencesFromCookieHeader = (cookieHeader: string | null | undefined): StoredMailUserPreferences => {
  let mailboxes: Record<string, unknown> = {};
  for (const part of (cookieHeader ?? "").split(";")) {
    const trimmed = part.trim();
    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex <= 0 || trimmed.slice(0, separatorIndex) !== MAIL_USER_PREFERENCES_COOKIE) continue;
    try {
      const settings = asRecord(JSON.parse(decodeURIComponent(trimmed.slice(separatorIndex + 1))));
      const parsedMailboxes = asRecord(settings?.mailboxes);
      if (parsedMailboxes) mailboxes = parsedMailboxes;
    } catch {
      // Ignore malformed duplicates and keep the last valid settings value.
    }
  }
  return { mailboxes };
};

export const readMailUserPreferencesFromCookieHeader = (cookieHeader: string | null | undefined, mailboxId: string): MailUserPreferences =>
  normalizeMailUserPreferences(readStoredMailUserPreferencesFromCookieHeader(cookieHeader).mailboxes[mailboxId]);
