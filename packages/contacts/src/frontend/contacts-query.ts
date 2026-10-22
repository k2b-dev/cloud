import type { ContactPresenceFilter, ContactSort } from "../service";

type ContactsQueryOptions = {
  sort: ContactSort;
  email: ContactPresenceFilter;
  phone: ContactPresenceFilter;
  favorites: boolean;
};

type ContactsQueryPatch = {
  sort?: ContactSort;
  email?: ContactPresenceFilter;
  phone?: ContactPresenceFilter;
  favorites?: boolean;
};

export const parseContactsQueryOptions = (query: (name: string) => string | null | undefined): ContactsQueryOptions => {
  const sort = query("sort");
  const email = query("email");
  const phone = query("phone");
  return {
    sort: (["updated", "created", "company"] as const).includes(sort as "updated" | "created" | "company")
      ? (sort as ContactSort)
      : ("name" as const),
    email: email === "yes" || email === "no" ? email : ("all" as const),
    phone: phone === "yes" || phone === "no" ? phone : ("all" as const),
    favorites: query("favorites") === "true",
  };
};

export const readContactsQueryOptions = (href: string): ContactsQueryOptions => {
  const url = new URL(href, "http://contacts.local");
  return parseContactsQueryOptions((name) => url.searchParams.get(name));
};

export const buildContactsQueryHref = (href: string, patch: ContactsQueryPatch): string => {
  const url = new URL(href, "http://contacts.local");
  url.searchParams.delete("contactOutcome");
  const options = { ...readContactsQueryOptions(href), ...patch };
  if (options.sort === "name") url.searchParams.delete("sort");
  else url.searchParams.set("sort", options.sort);
  if (options.email === "all") url.searchParams.delete("email");
  else url.searchParams.set("email", options.email);
  if (options.phone === "all") url.searchParams.delete("phone");
  else url.searchParams.set("phone", options.phone);
  if (options.favorites) url.searchParams.set("favorites", "true");
  else url.searchParams.delete("favorites");
  url.searchParams.delete("page");
  url.searchParams.delete("contact");
  url.searchParams.delete("contactBook");
  return `${url.pathname}${url.search}`;
};
