import { CapabilityAppIdSchema, CapabilityLocalIdSchema, type ContactDirectoryFunction } from "@k2b/cloud/contracts";
import type { Context } from "hono";
import { z } from "zod";

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

export const MAIL_CONTACT_DIRECTORY_SETTING_KEYS = {
  appId: "mail.contact_directory.app",
  suggest: "mail.contact_directory.suggest",
  resolve: "mail.contact_directory.resolve",
  read: "mail.contact_directory.read",
  listWritableBooks: "mail.contact_directory.list_writable_books",
  create: "mail.contact_directory.create",
} as const;

const capabilitySetting = (label: string, labelDe: string, fallback: string, optional: boolean) => ({
  kind: "string" as const,
  label,
  description: optional
    ? "Capability ID in the contact directory app. Empty hides the Mail features that need it. Change it under Administration → Mail → Contact directory."
    : "Capability ID in the contact directory app. Change it under Administration → Mail → Contact directory.",
  default: fallback,
  presentation: {
    translations: {
      de: {
        label: labelDe,
        description: optional
          ? "Capability-ID in der Kontaktverzeichnis-App. Leer blendet die Mail-Funktionen aus, die sie benötigen. Unter Administration → Mail → Kontaktverzeichnis ändern."
          : "Capability-ID in der Kontaktverzeichnis-App. Unter Administration → Mail → Kontaktverzeichnis ändern.",
      },
    },
  },
});

export const MAIL_CONTACT_DIRECTORY_SETTINGS = {
  [MAIL_CONTACT_DIRECTORY_SETTING_KEYS.appId]: {
    kind: "string",
    label: "Contact directory app",
    description:
      "Application that Mail uses for recipient suggestions and contact context. Change it under Administration → Mail → Contact directory.",
    default: MAIL_CONTACT_DIRECTORY_DEFAULTS.appId,
    presentation: {
      translations: {
        de: {
          label: "Kontaktverzeichnis-App",
          description:
            "Anwendung, die Mail für Empfängervorschläge und Kontaktkontext verwendet. Unter Administration → Mail → Kontaktverzeichnis ändern.",
        },
      },
    },
  },
  [MAIL_CONTACT_DIRECTORY_SETTING_KEYS.suggest]: capabilitySetting(
    "Suggest recipients",
    "Empfänger vorschlagen",
    MAIL_CONTACT_DIRECTORY_DEFAULTS.suggest,
    false,
  ),
  [MAIL_CONTACT_DIRECTORY_SETTING_KEYS.resolve]: capabilitySetting(
    "Match participants",
    "Beteiligte zuordnen",
    MAIL_CONTACT_DIRECTORY_DEFAULTS.resolve,
    false,
  ),
  [MAIL_CONTACT_DIRECTORY_SETTING_KEYS.read]: capabilitySetting(
    "Read a contact",
    "Kontakt lesen",
    MAIL_CONTACT_DIRECTORY_DEFAULTS.read,
    true,
  ),
  [MAIL_CONTACT_DIRECTORY_SETTING_KEYS.listWritableBooks]: capabilitySetting(
    "List writable books",
    "Beschreibbare Bücher auflisten",
    MAIL_CONTACT_DIRECTORY_DEFAULTS.listWritableBooks,
    true,
  ),
  [MAIL_CONTACT_DIRECTORY_SETTING_KEYS.create]: capabilitySetting(
    "Create a contact",
    "Kontakt anlegen",
    MAIL_CONTACT_DIRECTORY_DEFAULTS.create,
    true,
  ),
} as const;

export type ContactDirectoryTarget = { appId: string; capabilityId: string };

/** Resolved runtime mapping. `null` means the function is not available in this installation. */
export type MailContactDirectory = Record<ContactDirectoryFunction, ContactDirectoryTarget | null>;

export type MailContactDirectoryConfig = {
  appId: string;
} & Record<ContactDirectoryFunction, string>;

/**
 * The one resolver every Mail call site uses. An empty or malformed stored ID
 * leaves the function unmapped, so Mail degrades instead of calling a guess.
 */
export const resolveMailContactDirectory = (config: MailContactDirectoryConfig): MailContactDirectory => {
  const appId = config.appId.trim();
  const validApp = CapabilityAppIdSchema.safeParse(appId).success;
  const target = (fn: ContactDirectoryFunction): ContactDirectoryTarget | null => {
    const capabilityId = config[fn].trim();
    return validApp && CapabilityLocalIdSchema.safeParse(capabilityId).success ? { appId, capabilityId } : null;
  };
  return {
    suggest: target("suggest"),
    resolve: target("resolve"),
    read: target("read"),
    listWritableBooks: target("listWritableBooks"),
    create: target("create"),
  };
};

/** "New contact" needs a writable-book list and the create Action; without both Mail hides it. */
export const canCreateDirectoryContacts = (directory: MailContactDirectory): boolean =>
  directory.listWritableBooks !== null && directory.create !== null;

export const DEFAULT_MAIL_CONTACT_DIRECTORY = resolveMailContactDirectory(MAIL_CONTACT_DIRECTORY_DEFAULTS);

const settingsSnapshotSchema = z.object({
  mail: z.object({
    contact_directory: z.object({
      app: z.string(),
      suggest: z.string(),
      resolve: z.string(),
      read: z.string(),
      list_writable_books: z.string(),
      create: z.string(),
    }),
  }),
});

/**
 * Reads the stored mapping from the request settings snapshot. Routers mounted
 * without the settings middleware, such as isolated route tests, use the
 * zero-configuration defaults.
 */
export const requestContactDirectoryConfig = (c: Context): MailContactDirectoryConfig => {
  const snapshot = settingsSnapshotSchema.safeParse(c.get("settings"));
  if (!snapshot.success) return { ...MAIL_CONTACT_DIRECTORY_DEFAULTS };
  const stored = snapshot.data.mail.contact_directory;
  return {
    appId: stored.app,
    suggest: stored.suggest,
    resolve: stored.resolve,
    read: stored.read,
    listWritableBooks: stored.list_writable_books,
    create: stored.create,
  };
};

export const requestContactDirectory = (c: Context): MailContactDirectory => resolveMailContactDirectory(requestContactDirectoryConfig(c));

const optionalCapabilityIdSchema = z.union([CapabilityLocalIdSchema, z.literal("")]);

export const mailContactDirectoryUpdateSchema = z
  .object({
    appId: CapabilityAppIdSchema,
    suggest: optionalCapabilityIdSchema,
    resolve: optionalCapabilityIdSchema,
    read: optionalCapabilityIdSchema,
    listWritableBooks: optionalCapabilityIdSchema,
    create: optionalCapabilityIdSchema,
  })
  .strict();
export type MailContactDirectoryUpdate = z.infer<typeof mailContactDirectoryUpdateSchema>;
