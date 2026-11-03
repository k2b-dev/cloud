import { i18n } from "@k2b/stdlib";

/** The standard folders whose provider default names Mail shows in the reader's language. */
export type StandardFolderNameKey = "inbox" | "drafts" | "sent" | "trash" | "junk" | "archive" | "all";

/**
 * The default names providers give each standard folder, lowercased: IMAP, Exchange and Outlook, Gmail, Apple
 * and Dovecot, in English and German. A folder with this role and another name keeps the name its owner chose.
 */
const DEFAULT_NAMES: Record<StandardFolderNameKey, ReadonlySet<string>> = {
  inbox: new Set(["inbox", "posteingang", "eingang"]),
  drafts: new Set(["drafts", "draft", "entwürfe", "entwurf"]),
  sent: new Set([
    "sent",
    "sent items",
    "sent mail",
    "sent messages",
    "gesendet",
    "gesendete elemente",
    "gesendete objekte",
    "gesendete nachrichten",
  ]),
  trash: new Set([
    "trash",
    "bin",
    "deleted",
    "deleted items",
    "deleted messages",
    "papierkorb",
    "gelöscht",
    "gelöschte elemente",
    "gelöschte objekte",
    "gelöschte nachrichten",
  ]),
  junk: new Set(["junk", "junk email", "junk e-mail", "junk mail", "spam", "junk-e-mail"]),
  archive: new Set(["archive", "archives", "archiv"]),
  all: new Set(["all mail", "alle nachrichten"]),
};

/** Gmail files its standard folders under this parent; a full path names the same folder as its leaf. */
const GMAIL_PARENT = /^\[(gmail|google mail)\]\//;

const isStandardFolderNameKey = (role: string): role is StandardFolderNameKey => Object.hasOwn(DEFAULT_NAMES, role);

/**
 * The message key of a folder's localized name: its role is a standard one and its name the provider's default
 * for that role. Otherwise null, and the folder shows its own name.
 */
export const standardFolderNameKey = (role: string, name: string): StandardFolderNameKey | null => {
  if (!isStandardFolderNameKey(role)) return null;
  const normalized = name.normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase().replace(GMAIL_PARENT, "");
  return DEFAULT_NAMES[role].has(normalized) ? role : null;
};

export const mailFolderNameMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      inbox: "Inbox",
      drafts: "Drafts",
      sent: "Sent",
      trash: "Trash",
      junk: "Junk",
      archive: "Archive",
      all: "All Mail",
    } satisfies Record<StandardFolderNameKey, string>,
    de: {
      inbox: "Eingang",
      drafts: "Entwürfe",
      sent: "Gesendet",
      trash: "Papierkorb",
      junk: "Spam",
      archive: "Archiv",
      all: "Alle Nachrichten",
    },
  },
});

export type MailFolderNamed = { role: string; name: string };

/**
 * A folder's name as the reader sees it in `locale`. Only display uses it; sync, moves, the API and the CLI keep
 * the server's name.
 */
export const mailFolderNames = (locale: string): ((folder: MailFolderNamed) => string) => {
  const t = mailFolderNameMessages.resolve([locale]).t;
  return (folder) => {
    const key = standardFolderNameKey(folder.role, folder.name);
    return key ? t[key] : folder.name;
  };
};
