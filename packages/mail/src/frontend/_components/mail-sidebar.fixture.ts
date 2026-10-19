import { DEFAULT_MAIL_CONTACT_DIRECTORY } from "../../contact-directory-settings";
import { createMailboxMenu, type MailboxMenuOptions } from "./MailboxMenu";
import type MailSidebar from "./MailSidebar";
import type { MailSidebarOpenMailbox } from "./MailSidebar";
import { createMailboxPreferences } from "./mail-mailbox-preferences";

export const mailboxMenuOptions = (overrides: Partial<MailboxMenuOptions> = {}): MailboxMenuOptions => ({
  mailboxId: "Box001",
  syncEnabled: true,
  needsConnection: false,
  canWrite: true,
  canAdmin: true,
  assignedOnly: false,
  managementOpening: null,
  settingsOpening: false,
  detailsOpening: false,
  onOpenDetails: () => {},
  onOpenHealth: () => {},
  onOpenSharedLinks: () => {},
  onOpenRemoteContent: () => {},
  onOpenSubscriptions: () => {},
  onOpenSettings: () => {},
  ...overrides,
});

export const openMailboxFixture = (overrides: Partial<MailSidebarOpenMailbox> = {}): MailSidebarOpenMailbox => ({
  mailboxId: "Box001",
  mailboxName: "Support",
  canWrite: true,
  assignedOnly: false,
  folders: [],
  scheduledMode: false,
  scheduledCount: 0,
  activeFolderId: null,
  activeView: null,
  viewCounts: { needs_action: 2, mine: 1, unassigned: 1, waiting: 3, done: 4, snoozed: 0, send_problems: 0, recently_active: 5, kept: 2 },
  menu: createMailboxMenu(() => mailboxMenuOptions()),
  onCompose: () => {},
  onMoveConversation: () => {},
  onNavigate: () => {},
  ...overrides,
});

export const mailSidebarFixture = (overrides: Partial<Parameters<typeof MailSidebar>[0]> = {}): Parameters<typeof MailSidebar>[0] => ({
  currentUserEmail: null,
  contactDirectory: DEFAULT_MAIL_CONTACT_DIRECTORY,
  mailboxes: [{ id: "Box001", name: "Support", health: "active", healthReason: null, receivingAddress: "support@example.test" }],
  preferences: createMailboxPreferences({ pinnedMailboxIds: [], hiddenMailboxIds: [] }),
  counts: [],
  canCreate: true,
  open: openMailboxFixture(),
  ...overrides,
});
