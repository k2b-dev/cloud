export const mailDraftReturnHref = (value: string, mailboxId: string): string => {
  const fallback = `/app/mail/${mailboxId}`;
  try {
    const url = new URL(value, "http://mail.local");
    return url.pathname === fallback ? `${url.pathname}${url.search}${url.hash}` : fallback;
  } catch {
    return fallback;
  }
};

export const mailDraftHref = (mailboxId: string, draftId: string, returnHref: string, options: { popout?: boolean } = {}): string => {
  const query = new URLSearchParams({ return: mailDraftReturnHref(returnHref, mailboxId) });
  if (options.popout) query.set("window", "1");
  return `/app/mail/${mailboxId}/compose/${draftId}?${query}`;
};

export const mailConversationHref = (mailboxId: string, conversationId: string, returnHref: string): string => {
  const target = new URL(mailDraftReturnHref(returnHref, mailboxId), "http://mail.local");
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

type MailtoRegistrationResult = { kind: "requested" } | { kind: "unsupported" } | { kind: "failed"; message: string };

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
  } catch (error) {
    return {
      kind: "failed",
      message: error instanceof Error ? error.message : "The browser did not allow email link registration.",
    };
  }
};
