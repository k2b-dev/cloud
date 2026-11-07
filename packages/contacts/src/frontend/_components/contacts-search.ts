export const buildContactsSearchHref = (href: string, search: string): string => {
  const url = new URL(href, "http://contacts.local");
  url.searchParams.delete("contactOutcome");
  url.searchParams.delete("address");
  const query = search.trim();
  if (query) url.searchParams.set("search", query);
  else url.searchParams.delete("search");
  url.searchParams.delete("page");
  url.searchParams.delete("contact");
  url.searchParams.delete("contactBook");
  return `${url.pathname}${url.search}`;
};

export const contactsResultSignature = (href: string): string => {
  const url = new URL(href, "http://contacts.local");
  url.searchParams.delete("contactOutcome");
  url.searchParams.delete("address");
  return [
    url.pathname,
    url.searchParams.get("search") ?? "",
    url.searchParams.get("tag_id") ?? "",
    url.searchParams.get("sort") ?? "name",
    url.searchParams.get("email") ?? "all",
    url.searchParams.get("phone") ?? "all",
    url.searchParams.get("favorites") ?? "false",
    url.searchParams.get("page") ?? "1",
  ].join("\u0000");
};

export const contactsResultHref = (href: string): string => {
  const url = new URL(href, "http://contacts.local");
  url.searchParams.delete("contactOutcome");
  url.searchParams.delete("address");
  url.searchParams.delete("contact");
  url.searchParams.delete("contactBook");
  return `${url.pathname}${url.search}`;
};

export const buildContactsPaginationBaseHref = (href: string): string => {
  const url = new URL(href, "http://contacts.local");
  url.searchParams.delete("contactOutcome");
  url.searchParams.delete("address");
  url.searchParams.delete("page");
  url.searchParams.delete("contact");
  url.searchParams.delete("contactBook");
  const query = url.searchParams.toString();
  return `${url.pathname}?${query ? `${query}&` : ""}page=`;
};

export const buildContactsPageHref = (href: string, page: number): string => {
  const url = new URL(href, "http://contacts.local");
  url.searchParams.delete("contactOutcome");
  url.searchParams.delete("address");
  if (page <= 1) url.searchParams.delete("page");
  else url.searchParams.set("page", String(page));
  url.searchParams.delete("contact");
  url.searchParams.delete("contactBook");
  return `${url.pathname}${url.search}`;
};

export const buildContactDetailHref = (href: string, contactId: string, bookId: string): string => {
  const url = new URL(href, "http://contacts.local");
  url.searchParams.delete("contactOutcome");
  url.searchParams.delete("address");
  url.searchParams.set("contact", contactId);
  url.searchParams.set("contactBook", bookId);
  return `${url.pathname}${url.search}`;
};
