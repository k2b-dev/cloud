import type { AccessEntry } from "@k2b/cloud/contracts";
import type {
  ComposeSignatureDefault,
  ComposeTemplate,
  Mailbox,
  MailboxComposeStyle,
  ProviderBinding,
  ProviderConnection,
  SenderIdentity,
} from "./contracts";
import type { MailAdminFolderView } from "./service/folders";
import type { LocalTag } from "./service/local-tags";
import type { SavedConversationView } from "./service/saved-views";

/** The mailbox's Code in numbers; `access` counts targets per type, titled by their own app. */
export type MailboxCodeSummary = { exists: boolean; automations: number; access: { title: string; count: number }[] };

export type MailboxAdminSettingsContext = {
  accessEntries: AccessEntry[];
  /** Null when Core did not answer; settings and the delete dialog then speak without numbers. */
  code: MailboxCodeSummary | null;
  bindings: ProviderBinding[];
  connections: ProviderConnection[];
  folders: MailAdminFolderView[];
  identities: SenderIdentity[];
};

export type MailboxSettingsContext = {
  mailbox: Mailbox;
  permission: "read" | "write" | "admin";
  integrations: {
    spacesCalendar: boolean;
  };
  organization: {
    savedViews: SavedConversationView[];
    localTags: LocalTag[];
  };
  compose: {
    templates: ComposeTemplate[];
    defaults: ComposeSignatureDefault[];
    style: MailboxComposeStyle;
    identities: SenderIdentity[];
  } | null;
  admin: MailboxAdminSettingsContext | null;
};
