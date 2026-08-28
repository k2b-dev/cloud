import { describe, expect, test } from "bun:test";
import { mailComposerMessages } from "./_components/mail-composer-messages";
import { mailConversationListMessages } from "./_components/mail-conversation-list-messages";
import { mailConversationUiMessages } from "./_components/mail-conversation-ui-messages";
import { mailMessageMessages } from "./_components/mail-message-messages";
import { mailRemainingMessages } from "./_components/mail-remaining-messages";
import { mailSettingsMessages } from "./_components/mail-settings-messages";
import { mailSidebarMessages } from "./_components/mail-sidebar-messages";
import { mailAutomationPageMessages } from "./mail-automation-page-messages";
import { mailOverviewMessages } from "./mail-overview-messages";
import { mailWorkspaceMessages } from "./mail-workspace-messages";

const catalogs = [
  mailAutomationPageMessages,
  mailOverviewMessages,
  mailSidebarMessages,
  mailConversationListMessages,
  mailMessageMessages,
  mailConversationUiMessages,
  mailWorkspaceMessages,
  mailComposerMessages,
  mailSettingsMessages,
  mailRemainingMessages,
];

describe("Mail browser message catalogs", () => {
  test("provide every German message", () => {
    for (const catalog of catalogs) expect(catalog.check()).toEqual([]);
  });

  test("inherit regional German locales", () => {
    expect(mailOverviewMessages.resolve(["de-CH"]).t.mailboxes).toBe("Postfächer");
    expect(mailSidebarMessages.resolve(["de-DE"]).t.needsAction).toBe("Handlungsbedarf");
    expect(mailWorkspaceMessages.resolve(["de-CH"]).t.moveToFolder).toBe("In Ordner verschieben");
    expect(mailConversationUiMessages.resolve(["de-CH"]).t.scheduled).toBe("Geplant");
    expect(mailComposerMessages.resolve(["de-CH"]).t.send).toBe("Senden");
    expect(mailSettingsMessages.resolve(["de-CH"]).t.retry).toBe("Erneut versuchen");
    expect(mailRemainingMessages.resolve(["de-CH"]).t.overview).toBe("Übersicht");
  });

  test("falls back to English for unsupported locales", () => {
    expect(mailWorkspaceMessages.resolve(["fr"]).t.moveToFolder).toBe("Move to folder");
    expect(mailConversationUiMessages.resolve(["fr"]).t.scheduled).toBe("Scheduled");
    expect(mailComposerMessages.resolve(["fr"]).t.send).toBe("Send");
    expect(mailSettingsMessages.resolve(["fr"]).t.retry).toBe("Retry");
    expect(mailRemainingMessages.resolve(["fr"]).t.overview).toBe("Overview");
  });

  test("keeps technical workflow terms exact", () => {
    const messages = mailAutomationPageMessages.resolve(["de"]).t;
    expect(messages.workflowsDescription).toContain("YAML");
    expect(messages.createIncomingAutomationDescription).toContain("KI-Ausgaben");
  });
});
