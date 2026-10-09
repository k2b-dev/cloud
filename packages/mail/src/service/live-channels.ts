import type { LiveViewer } from "@k2b/cloud/events";
import { z } from "zod";
import { ResourceShortIdSchema } from "../contracts";
import { getMailboxAccess, getMailboxAccesses, type MailboxAccess } from "./access";
import { resolvePublicId } from "./public-resources";

/**
 * The keys a reader follows for one mailbox. Mailbox-wide readers follow the mailbox itself, whose
 * updates name every conversation. Readers of assigned conversations only follow their own key,
 * which carries the updates of the conversations assigned to them, and the key of updates that name
 * no conversation; `mail.enqueue_live_invalidation()` writes both.
 */
export const mailboxLiveKeys = (mailboxId: string, access: MailboxAccess): string[] =>
  access.scope === "mailbox" ? [mailboxId] : [`${mailboxId}:${access.userId}`, `${mailboxId}:assigned`];

const parseKey = (key: string): { mailboxId: string; reader: string | null } => {
  const [mailboxId = "", reader = null] = key.split(":");
  return { mailboxId, reader };
};

/** Whether a reader with `access` may follow `key`: the same keys `mailboxLiveKeys()` gives it. */
const mayFollow = (key: string, access: MailboxAccess | null): boolean => {
  if (!access) return false;
  const { mailboxId } = parseKey(key);
  return mailboxLiveKeys(mailboxId, access).includes(key);
};

/** `mailbox` follows one mailbox; its readers are decided like the Mail API's, with one query for all of them. */
export const mailLiveChannels = {
  mailbox: {
    scope: z.object({ mailbox: ResourceShortIdSchema }).strict(),
    keys: async ({ mailbox }: { mailbox: string }, viewer: LiveViewer) => {
      const mailboxId = await resolvePublicId("mailboxes", mailbox);
      if (!mailboxId) return null;
      const access = await getMailboxAccess(viewer, mailboxId);
      return access ? mailboxLiveKeys(mailboxId, access) : null;
    },
    authorize: async (key: string, viewers: readonly LiveViewer[]): Promise<ReadonlySet<string>> => {
      const accesses = await getMailboxAccesses(parseKey(key).mailboxId, viewers);
      return new Set(viewers.filter((_, position) => mayFollow(key, accesses[position] ?? null)).map((viewer) => viewer.id));
    },
  },
};
