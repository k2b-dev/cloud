import { DEFAULT_LINUX_IDENTITY_CONFIGURATION } from "../../../packages/cloud/src/contracts/posix";
import { MAIL_CONTACT_DIRECTORY_DEFAULTS } from "../../../packages/mail/src/contact-directory";
import type { ContactDirectoryAdminView } from "../../../packages/mail/src/service/contact-directory";
export const storageView = {
  fileMiB: 50,
  totalMiB: 250,
  unreadable: { "assistant.storage_file_mib": true, "assistant.storage_total_mib": false },
};
export const databaseView = { url: "", tokenSet: false, unreadable: { "assistant.rsql_url": true, "assistant.rsql_api_token": true } };
export const retentionView = {
  contentDays: 30,
  recordDays: 90,
  unreadable: { "outgoing_mail.content_retention_days": true, "outgoing_mail.record_retention_days": false },
};
export const linuxOverview = { config: { ...DEFAULT_LINUX_IDENTITY_CONFIGURATION, unreadable: true }, items: [], nextCursor: null };
export const directoryView: ContactDirectoryAdminView = {
  config: { ...MAIL_CONTACT_DIRECTORY_DEFAULTS },
  unreadable: { "mail.contact_directory.suggest": true, "mail.contact_directory.resolve": true },
  issues: [],
  apps: [
    {
      appId: "contacts",
      appName: "Contacts",
      appIcon: "ti ti-address-book",
      capabilities: {
        suggest: [{ id: "contact.suggest", title: "Suggest contacts" }],
        resolve: [{ id: "contact.resolve", title: "Match contacts" }],
        read: [{ id: "contact.read", title: "Read contact" }],
        listWritableBooks: [{ id: "book.list", title: "List books" }],
        create: [{ id: "contact.create", title: "Create contact" }],
      },
    },
  ],
};

/** Opening snapshots for a value that becomes unreadable only after the editor opens. */
export const previewViews = (late: boolean) => ({
  storage: { ...storageView, unreadable: { ...storageView.unreadable, "assistant.storage_file_mib": !late } },
  database: {
    ...databaseView,
    url: late ? "https://database.example.test" : "",
    tokenSet: late,
    unreadable: { "assistant.rsql_url": !late, "assistant.rsql_api_token": !late },
  },
  linux: { ...linuxOverview, config: { ...linuxOverview.config, unreadable: !late } },
  outgoing: { ...retentionView, unreadable: { ...retentionView.unreadable, "outgoing_mail.content_retention_days": !late } },
  directory: {
    ...directoryView,
    config: { ...directoryView.config },
    unreadable: { "mail.contact_directory.suggest": !late, "mail.contact_directory.resolve": !late },
    apps:
      directoryView.apps?.map((app) => ({
        ...app,
        capabilities: {
          ...app.capabilities,
          suggest: [...app.capabilities.suggest, { id: "contact.suggestAlternate", title: "Suggest alternate contacts" }],
        },
      })) ?? null,
  },
  logs: { retentionDays: 30, unreadable: !late },
});
