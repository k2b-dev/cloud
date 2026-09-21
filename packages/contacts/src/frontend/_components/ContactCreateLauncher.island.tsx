import { consumeCommandLink, registerCommandHandler, registerContextAwareCommand } from "@k2b/cloud/browser/commands";
import { navigateTo } from "@k2b/ssr/nav";
import { useLocale } from "@k2b/ui";
import { createEffect, onCleanup, onMount } from "solid-js";
import { ContactComposeInputSchema } from "../../commands";
import { CONTACTS_CREATE_QUERY_KEYS, parseContactCreateSeed } from "../../integration";
import { openContactCreateFlow, type WritableContactBook } from "./ContactCreateFlow";
import { detailMessages } from "./detail-messages";

const contactHref = (bookId: string, contactId: string): string =>
  `/app/contacts/${encodeURIComponent(bookId)}?contact=${encodeURIComponent(contactId)}&contactBook=${encodeURIComponent(bookId)}`;

const consumeCreateQuery = (url: URL): void => {
  for (const key of CONTACTS_CREATE_QUERY_KEYS) url.searchParams.delete(key);
  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
};

export default function ContactCreateLauncher(props: { writableBooks: WritableContactBook[]; defaultBookId?: string }) {
  const locale = useLocale();
  let pending = false;
  let active = true;
  onCleanup(() => {
    active = false;
  });
  const create = async (bookId?: string) => {
    if (pending) return;
    pending = true;
    try {
      if (bookId && !props.writableBooks.some((book) => book.id === bookId))
        throw new Error(detailMessages.resolve([locale()]).t.noWritableBookHint);
      const result = await openContactCreateFlow({
        writableBooks: props.writableBooks,
        defaultBookId: bookId,
        chooseBook: !bookId,
        locale: locale(),
      });
      if (result && active) navigateTo(contactHref(result.bookId, result.contact.id));
    } finally {
      pending = false;
    }
  };
  createEffect(() => {
    if (!props.writableBooks.length) return;
    const copy = detailMessages.resolve([locale()]).t;
    const book = props.writableBooks.find((book) => book.id === props.defaultBookId);
    onCleanup(
      registerContextAwareCommand({
        id: "contacts.contact.compose",
        title: detailMessages.resolve([locale()]).t.newContact,
        description: book ? copy.newContactDescription({ name: book.name }) : copy.chooseBookDescription,
        icon: "ti ti-user-plus",
        shortcut: "mod+alt+n",
        action: { command: "contacts.contact.compose", input: props.defaultBookId ? { bookId: props.defaultBookId } : {} },
      }),
    );
  });
  onMount(() => {
    onCleanup(
      registerCommandHandler("contacts.contact.compose", ContactComposeInputSchema, (input) => create(input.bookId ?? props.defaultBookId)),
    );
    void consumeCommandLink();
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
