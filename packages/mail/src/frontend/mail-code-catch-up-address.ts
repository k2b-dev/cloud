// The address of the "Process existing mail" step on the mailbox's Code page. Pure, without UI imports.

/** Whether the address of the mailbox's Code page asks for the "Process existing mail" step. */
export const opensMailCodeCatchUp = (url: URL) => url.searchParams.get("catchUp") === "1";

/** Where the former address of the step (`…/code/catch-up?…`) leads now: the Code page in that step, its state kept. */
export const mailCodeCatchUpRedirect = (url: URL): string => {
  const query = new URLSearchParams(url.search);
  query.delete("catchUp");
  const rest = query.size ? `&${query}` : "";
  return `${url.pathname.replace(/\/catch-up$/, "")}?catchUp=1${rest}`;
};
