import { isMailActivityKind, MAIL_ACTIVITY_KINDS, type MailActivityKind } from "./mail-activity-kinds";

/** The mailbox head's Events tab: `?view=events`. It is no conversation view; the feed replaces the list. */
export const MAIL_EVENTS_VIEW = "events";

/** The feed's filter, kept in the URL so a reload and a shared link show the same events. */
export type MailEventsFilter = { kind: MailActivityKind | null; actorId: string | null; mine: boolean };

export const EMPTY_MAIL_EVENTS_FILTER: MailEventsFilter = { kind: null, actorId: null, mine: false };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const isMailEventsRoute = (url: URL): boolean => url.searchParams.get("view") === MAIL_EVENTS_VIEW;

export const readMailEventsFilter = (url: URL): MailEventsFilter => {
  const kind = url.searchParams.get("eventKind");
  const actorId = url.searchParams.get("eventActor");
  return {
    kind: isMailActivityKind(kind) ? kind : null,
    actorId: actorId && UUID.test(actorId) ? actorId : null,
    mine: url.searchParams.get("eventMine") === "1",
  };
};

export const mailEventsFiltered = (filter: MailEventsFilter): boolean => Boolean(filter.kind || filter.actorId || filter.mine);

/**
 * The Events tab of the current route with another filter or open conversation. Every other parameter stays, so an
 * event opens beside the same feed instead of loading it again; `conversation: null` closes the open one.
 */
export const mailEventsHref = (current: string, change: { filter?: MailEventsFilter; conversationId?: string | null }): string => {
  const url = new URL(current, "http://mail.local");
  url.searchParams.set("view", MAIL_EVENTS_VIEW);
  url.searchParams.delete("cursor");
  if (change.filter) {
    const values: Array<[string, string | null]> = [
      ["eventKind", change.filter.kind],
      ["eventActor", change.filter.actorId],
      ["eventMine", change.filter.mine ? "1" : null],
    ];
    for (const [name, value] of values) {
      if (value) url.searchParams.set(name, value);
      else url.searchParams.delete(name);
    }
  }
  if (change.conversationId !== undefined) {
    if (change.conversationId) url.searchParams.set("conversation", change.conversationId);
    else url.searchParams.delete("conversation");
  }
  return `${url.pathname}${url.search}`;
};

/** The kinds a filter shows: every feed kind unless one is chosen. */
export const mailEventsKinds = (filter: MailEventsFilter): readonly MailActivityKind[] =>
  filter.kind ? [filter.kind] : MAIL_ACTIVITY_KINDS;

/** The activity API's feed query for a filter. */
export const mailEventsQuery = (filter: MailEventsFilter): { kind: string; actor?: string; mine?: "true" } => ({
  kind: mailEventsKinds(filter).join(","),
  ...(filter.actorId ? { actor: filter.actorId } : {}),
  ...(filter.mine ? { mine: "true" as const } : {}),
});
