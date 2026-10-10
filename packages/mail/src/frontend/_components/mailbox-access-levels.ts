import type { AllowedLevel } from "@k2b/cloud/access/ui";
import type { Principal } from "@k2b/cloud/contracts";
import { i18n } from "@k2b/stdlib";

const messages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      viewAssigned: "View assigned only",
      viewAssignedDescription: "Sees only the conversations assigned to them.",
      editAssigned: "Edit assigned only",
      editAssignedDescription: "Sees only the conversations assigned to them, and can reply to and act on them.",
    },
    de: {
      viewAssigned: "Nur zugewiesene ansehen",
      viewAssignedDescription: "Sieht nur die Unterhaltungen, die der Person zugewiesen sind.",
      editAssigned: "Nur zugewiesene bearbeiten",
      editAssignedDescription:
        "Sieht nur die Unterhaltungen, die der Person zugewiesen sind, und kann darauf antworten und sie bearbeiten.",
    },
  },
});

/**
 * The levels of a mailbox grant: the mailbox-wide View, Edit and Manage, and, for people and groups,
 * View or Edit of only the conversations assigned to them. The service enforces the same rule.
 */
export const mailboxAccessLevels =
  (locale: string) =>
  (principal: Principal): AllowedLevel[] => {
    const mailboxWide: AllowedLevel[] = ["read", "write", "admin"];
    if (principal.type !== "user" && principal.type !== "group") return mailboxWide;
    const t = messages.resolve([locale]).t;
    return [
      ...mailboxWide,
      { level: "read", scope: "assigned", label: t.viewAssigned, icon: "ti-user-check", description: t.viewAssignedDescription },
      { level: "write", scope: "assigned", label: t.editAssigned, icon: "ti-user-edit", description: t.editAssignedDescription },
    ];
  };

/** The access API's scope for a level the editor chose: a whole-mailbox level has none. */
export const mailboxAccessScope = (scope: string | undefined): "mailbox" | "assigned" => (scope === "assigned" ? "assigned" : "mailbox");
