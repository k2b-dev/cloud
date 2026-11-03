import { type MailActivityKind, mailActivityKindSchema } from "./contracts";

/** The mailbox head's Events tab: `?view=events`. It is no conversation view; the feed replaces the list. */
export const MAIL_EVENTS_VIEW = "events";

/** The feed's filter, kept in the URL so a reload and a shared link show the same events. */
export type MailEventsFilter = { kind: MailActivityKind | null; actorId: string | null; mine: boolean };

export const EMPTY_MAIL_EVENTS_FILTER: MailEventsFilter = { kind: null, actorId: null, mine: false };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const isMailEventsRoute = (url: URL): boolean => url.searchParams.get("view") === MAIL_EVENTS_VIEW;

export const readMailEventsFilter = (url: URL): MailEventsFilter => {
  const kind = mailActivityKindSchema.safeParse(url.searchParams.get("eventKind") ?? undefined);
  const actorId = url.searchParams.get("eventActor");
  return {
    kind: kind.success ? kind.data : null,
    actorId: actorId && UUID.test(actorId) ? actorId : null,
    mine: url.searchParams.get("eventMine") === "1",
  };
};

export const mailEventsFiltered = (filter: MailEventsFilter): boolean => Boolean(filter.kind || filter.actorId || filter.mine);

/** The Events tab with a filter and, optionally, the conversation open beside it. */
export const mailEventsHref = (mailboxId: string, filter: MailEventsFilter, conversationId?: string | null): string => {
  const params = new URLSearchParams({ view: MAIL_EVENTS_VIEW });
  if (filter.kind) params.set("eventKind", filter.kind);
  if (filter.actorId) params.set("eventActor", filter.actorId);
  if (filter.mine) params.set("eventMine", "1");
  if (conversationId) params.set("conversation", conversationId);
  return `/app/mail/${mailboxId}?${params}`;
};

/** The kinds a filter shows: every feed kind unless one is chosen. */
export const mailEventsKinds = (filter: MailEventsFilter): readonly MailActivityKind[] =>
  filter.kind ? [filter.kind] : mailActivityKindSchema.options;

/** The activity API's feed query for a filter. */
export const mailEventsQuery = (filter: MailEventsFilter): { kind: string; actor?: string; mine?: "true" } => ({
  kind: mailEventsKinds(filter).join(","),
  ...(filter.actorId ? { actor: filter.actorId } : {}),
  ...(filter.mine ? { mine: "true" as const } : {}),
});
