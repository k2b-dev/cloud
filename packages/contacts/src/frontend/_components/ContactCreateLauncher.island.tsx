import { navigateTo } from "@k2b/ssr/nav";
import { useLocale } from "@k2b/ui";
import { onMount } from "solid-js";
import { CONTACTS_CREATE_QUERY_KEYS, parseContactCreateSeed } from "../../integration";
import { openContactCreateFlow, type WritableContactBook } from "./ContactCreateFlow";

const contactHref = (bookId: string, contactId: string): string =>
  `/app/contacts/${encodeURIComponent(bookId)}?contact=${encodeURIComponent(contactId)}&contactBook=${encodeURIComponent(bookId)}`;

const consumeCreateQuery = (url: URL): void => {
  for (const key of CONTACTS_CREATE_QUERY_KEYS) url.searchParams.delete(key);
  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
};

export default function ContactCreateLauncher(props: { writableBooks: WritableContactBook[] }) {
  const locale = useLocale();
  onMount(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.get("createContact") !== "1") return;
    const seed = parseContactCreateSeed(url.searchParams);
    consumeCreateQuery(url);
    if (!seed) return;
    void openContactCreateFlow({
      writableBooks: props.writableBooks,
      chooseBook: true,
      initialValues: { label: seed.name, email: seed.email },
      locale: locale(),
    }).then((result) => {
      if (result) navigateTo(contactHref(result.bookId, result.contact.id));
    });
  });

  return null;
}
