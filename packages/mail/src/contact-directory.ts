import type { ContactDirectoryFunction } from "@k2b/cloud/contracts";

/**
 * Mail's contact directory: one provider application and one capability per
 * contact-directory function. The defaults point at the built-in Contacts app,
 * so an installation without stored settings behaves exactly as before.
 */

export const MAIL_CONTACT_DIRECTORY_REQUIRED = ["suggest", "resolve"] as const satisfies readonly ContactDirectoryFunction[];
export const MAIL_CONTACT_DIRECTORY_OPTIONAL = [
  "read",
  "listWritableBooks",
  "create",
] as const satisfies readonly ContactDirectoryFunction[];

export const MAIL_CONTACT_DIRECTORY_DEFAULTS = {
  appId: "contacts",
  suggest: "contact.suggest",
  resolve: "contact.resolve",
  read: "contact.read",
  listWritableBooks: "book.list",
  create: "contact.create",
} as const satisfies { appId: string } & Record<ContactDirectoryFunction, string>;

export type ContactDirectoryTarget = { appId: string; capabilityId: string };

/** Resolved runtime mapping. `null` means the function is not available in this installation. */
export type MailContactDirectory = Record<ContactDirectoryFunction, ContactDirectoryTarget | null>;

export type MailContactDirectoryConfig = {
  appId: string;
} & Record<ContactDirectoryFunction, string>;

/** "New contact" needs a writable-book list and the create Action; without both Mail hides it. */
export const canCreateDirectoryContacts = (directory: MailContactDirectory): boolean =>
  directory.listWritableBooks !== null && directory.create !== null;

const defaultTarget = (fn: ContactDirectoryFunction): ContactDirectoryTarget => ({
  appId: MAIL_CONTACT_DIRECTORY_DEFAULTS.appId,
  capabilityId: MAIL_CONTACT_DIRECTORY_DEFAULTS[fn],
});

/** The defaults are valid IDs, so they map without the settings validators; a test pins this to `resolveMailContactDirectory`. */
export const DEFAULT_MAIL_CONTACT_DIRECTORY: MailContactDirectory = {
  suggest: defaultTarget("suggest"),
  resolve: defaultTarget("resolve"),
  read: defaultTarget("read"),
  listWritableBooks: defaultTarget("listWritableBooks"),
  create: defaultTarget("create"),
};
