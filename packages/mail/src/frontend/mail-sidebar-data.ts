import { logger } from "@k2b/cloud/services";
import { err, fail, ok, type Result } from "@k2b/stdlib";
import type { MailRequestContext } from "../service";
import { mailboxes, mailboxPreferences, publicResources } from "../service";
import type { MailSidebarMailbox } from "./_components/MailSidebar";
import { chooseLandingMailbox } from "./mail-landing";
import { projectSsrMailboxList } from "./ssr-public-boundary";

const log = logger("mail:landing");

export type MailSidebarData = {
  mailboxes: MailSidebarMailbox[];
  pinnedMailboxIds: string[];
  hiddenMailboxIds: string[];
  /** The one-time notice that Focus is gone, until the person closes it. */
  focusNoticeOpen: boolean;
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
 * Their counts would need a cross-mailbox read that slows every mailbox open. A failed read of the notice leaves it
 * closed for this page; the mailbox still opens.
 */
export const loadMailSidebarData = async (context: MailRequestContext): Promise<MailSidebarData> => {
  const [list, preferences, focusNoticeDismissed] = await Promise.all([
    loadSidebarMailboxes(context),
    loadSidebarPreferences(context),
    mailboxPreferences.focusNoticeDismissed(context).catch(() => true),
  ]);
  return {
    mailboxes: list.map(({ id, name, health, healthReason, receivingAddress }) => ({ id, name, health, healthReason, receivingAddress })),
    pinnedMailboxIds: preferences.publicPinnedMailboxIds,
    hiddenMailboxIds: preferences.publicHiddenMailboxIds,
    focusNoticeOpen: !focusNoticeDismissed,
  };
};

/**
 * Reads the mailboxes the sidebar lists and the person's pins and hidden mailboxes, and chooses one as a public ID,
 * or null without any. Unlike the sidebar's read, a failure stays a failure, so Mail never shows "no mailbox" for it.
 */
export const loadMailLanding = async (context: MailRequestContext, lastMailboxId: string | null): Promise<Result<string | null>> => {
  try {
    const [listed, preferences] = await Promise.all([mailboxes.listMailboxes(context, 200), loadSidebarPreferences(context)]);
    if (!listed.ok) return listed;
    const readable = await projectSsrMailboxList(listed.data.filter((mailbox) => mailbox.permission !== "none"));
    return ok(
      chooseLandingMailbox({
        mailboxIds: readable.map((mailbox) => mailbox.id),
        pinnedMailboxIds: preferences.publicPinnedMailboxIds,
        hiddenMailboxIds: preferences.publicHiddenMailboxIds,
        lastMailboxId,
      }),
    );
  } catch (error) {
    log.warn("Mail could not choose the mailbox to open", { error: error instanceof Error ? error.message : String(error) });
    return fail(err.internal("Mail could not read your mailboxes"));
  }
};
