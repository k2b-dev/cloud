import { cookies } from "@k2b/stdlib/browser";
import type { PanesLayout } from "@k2b/ui";
import { createSignal } from "solid-js";
import { MAIL_COMPOSER_PANES_COOKIE, normalizeMailComposerPanes } from "./mail-composer-panes";
import {
  MAIL_USER_PREFERENCES_COOKIE,
  type MailUserPreferences,
  normalizeMailUserPreferences,
  readStoredMailUserPreferencesFromCookieHeader,
} from "./mail-user-preferences";

const [preferencesRevision, setPreferencesRevision] = createSignal(0);

const readSettings = () => readStoredMailUserPreferencesFromCookieHeader(typeof document === "undefined" ? null : document.cookie);

export const readMailUserPreferences = (mailboxId: string): MailUserPreferences =>
  normalizeMailUserPreferences(readSettings().mailboxes[mailboxId]);

export const observeMailUserPreferences = (mailboxId: string, serverFallback?: MailUserPreferences): MailUserPreferences => {
  preferencesRevision();
  if (typeof document === "undefined") return normalizeMailUserPreferences(serverFallback);
  return readMailUserPreferences(mailboxId);
};

/** Changes the given preferences of one mailbox and keeps the others. */
export const writeMailUserPreferences = (mailboxId: string, preferences: Partial<MailUserPreferences>): MailUserPreferences => {
  const normalized = normalizeMailUserPreferences({ ...readMailUserPreferences(mailboxId), ...preferences });
  const current = readSettings();
  cookies.writeJsonCookie(MAIL_USER_PREFERENCES_COOKIE, {
    mailboxes: {
      ...current.mailboxes,
      [mailboxId]: normalized,
    },
  });
  setPreferencesRevision((revision) => revision + 1);
  return normalized;
};

export { normalizeMailComposerPanes } from "./mail-composer-panes";
export type { MailReadingFormat, MailUserPreferences } from "./mail-user-preferences";
export { normalizeMailUserPreferences } from "./mail-user-preferences";

export const writeMailComposerPanes = (value: PanesLayout): PanesLayout => {
  const composerPanes = normalizeMailComposerPanes(value);
  cookies.writeJsonCookie(MAIL_COMPOSER_PANES_COOKIE, composerPanes);
  return composerPanes;
};
