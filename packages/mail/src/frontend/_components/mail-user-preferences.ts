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

/**
 * The most the preferences cookie may hold, name and value together. RFC 6265 asks browsers to keep at least 4096
 * bytes per cookie; the margin covers the attributes Mail writes with it, which some browsers count too. A browser
 * drops a larger cookie without a word, and every preference would stop being saved.
 */
export const MAIL_USER_PREFERENCES_COOKIE_BUDGET = 4000;

/** Only the preferences that differ from the defaults, so a mailbox nobody changed costs nothing. */
const changedMailUserPreferences = (preferences: MailUserPreferences): Partial<MailUserPreferences> => ({
  ...(preferences.composeFormat !== DEFAULT_MAIL_USER_PREFERENCES.composeFormat ? { composeFormat: preferences.composeFormat } : {}),
  ...(preferences.readingFormat !== DEFAULT_MAIL_USER_PREFERENCES.readingFormat ? { readingFormat: preferences.readingFormat } : {}),
  ...(preferences.undoSeconds !== DEFAULT_MAIL_USER_PREFERENCES.undoSeconds ? { undoSeconds: preferences.undoSeconds } : {}),
  ...(preferences.dismissedFolderHints.length > 0 ? { dismissedFolderHints: preferences.dismissedFolderHints } : {}),
});

const cookieBytes = (mailboxes: ReadonlyArray<readonly [string, Partial<MailUserPreferences>]>): number =>
  `${MAIL_USER_PREFERENCES_COOKIE}=${encodeURIComponent(JSON.stringify({ mailboxes: Object.fromEntries(mailboxes) }))}`.length;

/**
 * The stored preferences after one mailbox changed, within the cookie budget. The changed mailbox moves to the end, so
 * the mailboxes run from the least to the most recently changed. Over the budget, the dismissed hints go first: those
 * of the least recently changed mailboxes, then the oldest of this one. Only then do whole mailboxes go, oldest first.
 */
export const storeMailUserPreferences = (
  stored: StoredMailUserPreferences,
  mailboxId: string,
  preferences: MailUserPreferences,
): StoredMailUserPreferences => {
  const mailboxes: Array<[string, Partial<MailUserPreferences>]> = [
    ...Object.entries(stored.mailboxes)
      .filter(([id]) => id !== mailboxId)
      .map(([id, value]): [string, Partial<MailUserPreferences>] => [id, changedMailUserPreferences(normalizeMailUserPreferences(value))]),
    [mailboxId, changedMailUserPreferences(preferences)],
  ];
  const fits = () => cookieBytes(mailboxes) <= MAIL_USER_PREFERENCES_COOKIE_BUDGET;
  for (const [, changed] of mailboxes.slice(0, -1)) {
    if (fits()) break;
    delete changed.dismissedFolderHints;
  }
  const current = mailboxes.at(-1)![1];
  while (!fits() && current.dismissedFolderHints?.length) current.dismissedFolderHints = current.dismissedFolderHints.slice(1);
  while (!fits() && mailboxes.length > 1) mailboxes.shift();
  return { mailboxes: Object.fromEntries(mailboxes.filter(([, changed]) => Object.keys(changed).length > 0)) };
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
