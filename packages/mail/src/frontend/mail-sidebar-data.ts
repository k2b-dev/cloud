import type { MailRequestContext } from "../service";
import { focus, mailboxes, mailboxPreferences, publicResources } from "../service";
import type { MailSidebarMailbox, MailSidebarMailboxCounts } from "./_components/MailSidebar";
import { projectSsrMailboxList, projectSsrPaths, type SsrPublicPath } from "./ssr-public-boundary";

export type MailSidebarData = {
  mailboxes: MailSidebarMailbox[];
  pinnedMailboxIds: string[];
  hiddenMailboxIds: string[];
  mailboxCounts: MailSidebarMailboxCounts[];
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
 * Everything the mailbox page's sidebar shows besides the open mailbox: the same mailboxes, pins, hidden mailboxes,
 * and counts as Focus, read through the same services. A failed count read leaves the counts out, not the page.
 */
export const loadMailSidebarData = async (context: MailRequestContext): Promise<MailSidebarData> => {
  const [list, preferences, counts] = await Promise.all([
    loadSidebarMailboxes(context),
    loadSidebarPreferences(context),
    focus.listMailboxCounts(context),
  ]);
  const internalCounts = counts.ok ? counts.data : [];
  const paths: SsrPublicPath[] = internalCounts.map((_, index) => ({ table: "mailboxes", segments: [index, "mailboxId"] }));
  return {
    mailboxes: list.map(({ id, name, health, healthReason, receivingAddress }) => ({ id, name, health, healthReason, receivingAddress })),
    pinnedMailboxIds: preferences.publicPinnedMailboxIds,
    hiddenMailboxIds: preferences.publicHiddenMailboxIds,
    mailboxCounts: await projectSsrPaths(internalCounts, paths),
  };
};
