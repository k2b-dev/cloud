import { commandPath } from "@k2b/cloud/contracts/commands";
import { plainContactsClick } from "./contacts-head-events";

export const contactsPrimaryHref = (href: string, bookId?: string) => {
  const input = bookId ? { bookId } : {};
  try {
    return commandPath(href, "contacts.contact.compose", input);
  } catch {
    return commandPath(new URL(href, "http://contacts.local").pathname, "contacts.contact.compose", input);
  }
};

/** Preserve native command links for modified clicks, new tabs, and before hydration. */
export const interceptContactsPrimaryClick = (document: Document, create: () => void) => {
  const click = (event: MouseEvent) => {
    if (!plainContactsClick(event) || !(event.target instanceof Element)) return;
    const anchor = event.target.closest("a");
    if (!anchor?.hasAttribute("data-workspace-primary") || anchor.hasAttribute("download") || (anchor.target && anchor.target !== "_self"))
      return;
    event.preventDefault();
    create();
  };
  document.addEventListener("click", click, true);
  return () => document.removeEventListener("click", click, true);
};
