import { mailFocusViewSchema, ResourceShortIdSchema } from "../contracts";

/** The mailbox views that stand for the views of the former Focus page; "all" is the mailbox's default. */
const FOCUS_VIEW_IN_MAILBOX = { mine: "mine", unassigned: "unassigned", waiting: "waiting", all: null } as const;

/**
 * Old links to the former Focus page. A conversation link opens it in its mailbox; a Focus view opens the same view
 * in the mailbox Mail opens. Mailbox access is checked by the mailbox page.
 */
export const readMailLandingLink = (
  query: (name: string) => string | undefined,
): { href: string } | { view: (typeof FOCUS_VIEW_IN_MAILBOX)[keyof typeof FOCUS_VIEW_IN_MAILBOX] } => {
  const mailbox = ResourceShortIdSchema.safeParse(query("mailbox"));
  const conversation = ResourceShortIdSchema.safeParse(query("conversation"));
  if (mailbox.success) {
    return { href: `/app/mail/${mailbox.data}${conversation.success ? `?conversation=${conversation.data}` : ""}` };
  }
  const view = mailFocusViewSchema.safeParse(query("view"));
  return { view: view.success ? FOCUS_VIEW_IN_MAILBOX[view.data] : null };
};

/**
 * The mailbox Mail opens: the only one; else the last one this browser opened while it is still readable and shown;
 * else the first pinned, then the first listed. Hidden mailboxes count only when every mailbox is hidden.
 */
export const chooseLandingMailbox = (input: {
  mailboxIds: readonly string[];
  pinnedMailboxIds: readonly string[];
  hiddenMailboxIds: readonly string[];
  lastMailboxId: string | null;
}): string | null => {
  if (input.mailboxIds.length <= 1) return input.mailboxIds[0] ?? null;
  const shown = input.mailboxIds.filter((id) => !input.hiddenMailboxIds.includes(id));
  if (input.lastMailboxId && shown.includes(input.lastMailboxId)) return input.lastMailboxId;
  const candidates = shown.length > 0 ? shown : input.mailboxIds;
  return input.pinnedMailboxIds.find((id) => candidates.includes(id)) ?? candidates[0] ?? null;
};
