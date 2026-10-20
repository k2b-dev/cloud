import type { MailRequestContext } from "../service";
import { mailboxes, mailboxPreferences, publicResources } from "../service";
import type { MailSidebarMailbox } from "./_components/MailSidebar";
import { projectSsrMailboxList } from "./ssr-public-boundary";

export type MailSidebarData = {
  mailboxes: MailSidebarMailbox[];
  pinnedMailboxIds: string[];
  hiddenMailboxIds: string[];
};

/** The readable mailboxes a sidebar lists, at most as many as the readable-mailbox endpoint returns. */
export const loadSidebarMailboxes = async (context: MailRequestContext) => {
  const result = await mailboxes.listMailboxes(context, 200);
  const list = result.ok
    ? result.data.filter((mailbox): mailbox is typeof mailbox & { permission: "read" | "write" | "admin" } => mailbox.permission !== "none")
    : [];
  return projectSsrMailboxList(list);
};

/** The person's pins and hidden mailboxes as public IDs, and the internal hidden IDs Focus leaves out. */
export const loadSidebarPreferences = async (context: MailRequestContext) => {
  const stored = await mailboxPreferences.listMailboxPreferences(context);
  const shortIds = await publicResources.publicIds("mailboxes", [...stored.pinnedMailboxIds, ...stored.hiddenMailboxIds]);
  const toPublic = (ids: string[]) => ids.flatMap((id) => shortIds.get(id) ?? []);
  return {
    hiddenMailboxIds: stored.hiddenMailboxIds,
    publicPinnedMailboxIds: toPublic(stored.pinnedMailboxIds),
    publicHiddenMailboxIds: toPublic(stored.hiddenMailboxIds),
  };
};

/**
 * The mailbox page's sidebar names the other mailboxes without counts, alongside pins and hidden mailboxes.
 * Their counts need the cross-mailbox Focus read that would slow every mailbox open; Focus shows them.
 */
export const loadMailSidebarData = async (context: MailRequestContext): Promise<MailSidebarData> => {
  const [list, preferences] = await Promise.all([loadSidebarMailboxes(context), loadSidebarPreferences(context)]);
  return {
    mailboxes: list.map(({ id, name, health, healthReason, receivingAddress }) => ({ id, name, health, healthReason, receivingAddress })),
    pinnedMailboxIds: preferences.publicPinnedMailboxIds,
    hiddenMailboxIds: preferences.publicHiddenMailboxIds,
  };
};
