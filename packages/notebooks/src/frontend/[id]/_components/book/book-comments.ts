import { withPresentationMode } from "../../../../lib/presentation-url";

/** The note's open comments in Book: a quiet entry that opens Read at the first one; Book itself shows none. */
export const commentsHref = (href: string) => {
  const url = new URL(withPresentationMode(href, "readonly"), "http://local");
  url.searchParams.set("annotation", "first");
  url.hash = "";
  return `${url.pathname}${url.search}`;
};
