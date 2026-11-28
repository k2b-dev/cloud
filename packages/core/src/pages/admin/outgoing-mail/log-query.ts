import { type AdminMailApp, type MailStatus, MailStatusSchema } from "@k2b/cloud/contracts";
import { defineListQuery, field, type ListQueryStateOf } from "@k2b/ui/v2/list-query";
import { outgoingMailMessages } from "./messages";
import { OUTGOING_MAIL_HREF } from "./paths";

type Messages = ReturnType<typeof outgoingMailMessages.resolve>["t"];

export const statusLabel = (status: MailStatus, t: Messages) =>
  ({
    queued: t.statusQueued,
    sending: t.statusSending,
    sent: t.statusSent,
    failed: t.statusFailed,
    bounced: t.statusBounced,
    cancelled: t.statusCancelled,
  })[status];

/**
 * The send log in the address: one app, one state and a search for a recipient (`q`), newest first. The apps come from
 * the server, so the server and the island declare the same values.
 */
export const logQuery = (locale: string, apps: readonly Pick<AdminMailApp, "appId" | "name">[]) => {
  const t = outgoingMailMessages.resolve([locale]).t;
  return defineListQuery({
    key: "core.outgoing-mail.log",
    fields: {
      app: field.choice({
        label: t.app,
        options: apps.map((app) => ({ value: app.appId, label: app.name })),
        multiple: false,
        common: true,
      }),
      status: field.choice({
        label: t.statusLabel,
        options: MailStatusSchema.options.map((value) => ({ value, label: statusLabel(value, t) })),
        multiple: false,
        common: true,
      }),
    },
    search: { label: t.recipientSearch },
    sort: { fixed: { field: "created", direction: "desc", label: t.newestFirst } },
  });
};
export type LogQuery = ReturnType<typeof logQuery>;
export type LogState = ListQueryStateOf<LogQuery>;

/** The log's address, with the open message (`message=`). */
export const logHref = (query: LogQuery, state: LogState, message?: string | null) => {
  const params = query.serialize(state);
  if (message) params.set("message", message);
  const search = params.toString();
  return search ? `${OUTGOING_MAIL_HREF.log}?${search}` : OUTGOING_MAIL_HREF.log;
};

/** Reads the address; the search of before v2 (`recipient=`) leads to the same log with `q=`, `redirect` set then. */
export const parseLogAddress = (query: LogQuery, params: URLSearchParams) => {
  const own = new URLSearchParams(params);
  const message = own.get("message");
  own.delete("message");
  const legacy = own.get("recipient");
  own.delete("recipient");
  if (legacy !== null && !own.has("q") && legacy.trim()) own.set("q", legacy.trim().slice(0, 320));
  const { state } = query.parse(own);
  return { state, message, redirect: legacy !== null ? logHref(query, state, message) : null };
};

/** The service's filter for a state. */
export const logFilter = (state: LogState) => {
  const status = MailStatusSchema.safeParse(state.filters.status).data;
  return {
    ...(state.filters.app ? { app: state.filters.app } : {}),
    ...(status ? { status: [status] } : {}),
    ...(state.search ? { recipient: state.search } : {}),
  };
};
