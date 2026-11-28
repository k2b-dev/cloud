// The address of the retired rules' history on the mailbox's Code page. Pure, without UI imports.

/** Whether the address of the mailbox's Code page asks for the history of the retired rules. */
export const opensMailCodeHistory = (url: URL) => url.searchParams.get("history") === "1";

/** Where the former history page (`…/automations/log?…`) leads now: the Code page in that step, its day, entry and run kept. */
export const mailCodeHistoryRedirect = (url: URL): string => {
  const query = new URLSearchParams(url.search);
  query.delete("history");
  const rest = query.size ? `&${query}` : "";
  return `${url.pathname.replace(/\/automations\/log$/, "/code")}?history=1${rest}`;
};
