import type { Context } from "hono";
import { type MailRequestContext, mailboxes, senderIdentities } from "../service";
import { requestContactDirectory } from "../service/contact-directory";
import { parseMailtoIntent } from "./_components/mail-compose-intent";
import type { MailComposeIntentProps } from "./_components/mail-compose-intent-state";
import { projectSsrMailboxList, projectSsrPaths } from "./ssr-public-boundary";

const MAILBOX_PAGE = 200;

/**
 * What "New message" starts from, read from its parameters (`mailbox`, `mailto`, `command`, `autostart`, `return`): the
 * mailboxes this person may write new mail from, the one to start with, and a sender when there is nothing to choose.
 * The v1 page `/app/mail/compose` and the v2 dialog over a mailbox (`?compose=1`) read it alike; `currentMailboxId` is
 * the mailbox under the dialog, the one to start with when no other is asked for.
 */
export const loadMailComposeIntent = async (
  c: Context,
  context: MailRequestContext,
  user: { id: string; mail: string | null } | null | undefined,
  currentMailboxId: string | null = null,
): Promise<MailComposeIntentProps> => {
  const result = await mailboxes.listMailboxes(context, MAILBOX_PAGE);
  const internalWritableMailboxes = result.ok
    ? result.data
        // New mail needs mailbox-wide write access; a writer of assigned conversations only replies in them.
        .filter((mailbox) => mailbox.accessScope === "mailbox" && (mailbox.permission === "write" || mailbox.permission === "admin"))
        .map((mailbox) => ({
          id: mailbox.id,
          name: mailbox.name,
          description: mailbox.description,
          canManage: mailbox.permission === "admin",
        }))
    : [];
  const writableMailboxes = await projectSsrMailboxList(internalWritableMailboxes);
  // One sending mailbox with one verified sender leaves nothing to choose, so the page opens that composer directly.
  // Anything else, including a sender that is not verified, keeps the choosers and their explanations. A full page may
  // hide further writable mailboxes, so only a complete list can prove there is one.
  const onlyMailbox =
    result.ok && result.data.length < MAILBOX_PAGE && internalWritableMailboxes.length === 1 && parseMailtoIntent(c.req.query("mailto")).ok
      ? internalWritableMailboxes[0]
      : undefined;
  const onlyMailboxIdentities = onlyMailbox ? await senderIdentities.listSenderIdentities(context, onlyMailbox.id) : null;
  const onlyIdentity =
    onlyMailboxIdentities?.ok && onlyMailboxIdentities.data.length === 1 && onlyMailboxIdentities.data[0]!.status === "verified"
      ? onlyMailboxIdentities.data[0]!
      : null;
  const directIdentityId = onlyIdentity
    ? (await projectSsrPaths({ id: onlyIdentity.id }, [{ table: "senderIdentities", segments: ["id"] }])).id
    : null;
  const writable = (id: string | null | undefined) => Boolean(id) && writableMailboxes.some((mailbox) => mailbox.id === id);
  const requestedMailboxId = c.req.query("mailbox");
  const initialMailboxId = writable(requestedMailboxId)
    ? requestedMailboxId!
    : writable(currentMailboxId)
      ? currentMailboxId!
      : writableMailboxes.length === 1
        ? writableMailboxes[0]!.id
        : "";
  return {
    mailboxes: writableMailboxes,
    initialMailboxId,
    directIdentityId,
    commandPending: Boolean(c.req.query("command")),
    autoStart: !c.req.query("command") && c.req.query("autostart") === "1" && Boolean(initialMailboxId) && !c.req.query("mailto"),
    mailto: c.req.query("mailto") ?? null,
    returnHref: c.req.query("return") ?? null,
    contactDirectory: await requestContactDirectory(c),
    currentUserId: user?.id,
    currentUserEmail: user?.mail ?? null,
  };
};
