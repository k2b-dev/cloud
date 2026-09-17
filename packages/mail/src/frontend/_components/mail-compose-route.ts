import { commandPath, readCommand, CommandPathSchema } from "@k2b/cloud/contracts";
import { MailDraftCalendarInputSchema } from "../../commands";

export const mailDraftReturnHref = (value: string, mailboxId: string): string =>
  CommandPathSchema.safeParse(value).success ? value : `/app/mail/${mailboxId}`;

export const mailDraftHref = (mailboxId: string, draftId: string, returnHref: string, options: { popout?: boolean } = {}): string => {
  const query = new URLSearchParams({ return: mailDraftReturnHref(returnHref, mailboxId) });
  if (options.popout) query.set("window", "1");
  return `/app/mail/${mailboxId}/compose/${draftId}?${query}`;
};

export const mailConversationHref = (mailboxId: string, conversationId: string, returnHref: string): string => {
  const target = new URL(mailDraftReturnHref(returnHref, mailboxId), "http://mail.local");
  if (target.pathname !== `/app/mail/${mailboxId}`) return `${target.pathname}${target.search}${target.hash}`;
  target.searchParams.delete("message");
  target.searchParams.set("conversation", conversationId);
  return `${target.pathname}${target.search}`;
};

export const mailDraftSeedHref = (mailboxId: string, seedId: string, returnHref: string, options: { popout?: boolean } = {}): string => {
  const query = new URLSearchParams({ return: mailDraftReturnHref(returnHref, mailboxId) });
  if (options.popout) query.set("window", "1");
  return `/app/mail/${mailboxId}/compose/local/${seedId}?${query}`;
};

export const mailtoHandlerTemplate = (origin: string): string => `${origin.replace(/\/+$/, "")}/app/mail/compose?mailto=%s`;

type MailtoRegistrationResult = { kind: "requested" } | { kind: "unsupported" } | { kind: "failed" };

export const registerMailtoHandler = (
  navigatorValue: Pick<Navigator, "registerProtocolHandler"> | Record<string, never>,
  origin: string,
): MailtoRegistrationResult => {
  if (!("registerProtocolHandler" in navigatorValue) || typeof navigatorValue.registerProtocolHandler !== "function") {
    return { kind: "unsupported" };
  }
  try {
    navigatorValue.registerProtocolHandler("mailto", mailtoHandlerTemplate(origin));
    return { kind: "requested" };
  } catch {
    return { kind: "failed" };
  }
};

/** Resolve the fixed Command entry route into the existing permission-checked draft page. */
export const mailCalendarCommandHref = (url: URL): string | null => {
  try {
    const target = readCommand(url);
    if (target?.id !== "mail.draft.calendar") return null;
    const input = MailDraftCalendarInputSchema.parse(target.input);
    return commandPath(
      mailDraftHref(input.mailboxId, input.draftId, target.options.returnTo ?? `/app/mail/${input.mailboxId}`),
      target.id,
      input,
      target.options,
    );
  } catch {
    return null;
  }
};
