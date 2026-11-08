import { AppWorkspace, useLocale } from "@k2b/ui";
import { type ComponentProps, createSignal, onCleanup, onMount } from "solid-js";
import ContactDetailPanel from "./ContactDetailPanel.island";
import ContactsWorkspaceMain from "./ContactsWorkspaceMain";
import CreateContactButton from "./CreateContactButton.island";
import { CONTACT_DETAIL_EVENT, type ContactDetailPayload, clearSelectedContactInUrl, getSelectedContactFromUrl } from "./context";
import { detailMessages } from "./detail-messages";
import { resultsMessages } from "./results-messages";

type Props = {
  list: ComponentProps<typeof ContactsWorkspaceMain>;
  reader: ComponentProps<typeof ContactDetailPanel>;
};

type Selection = ReturnType<typeof getSelectedContactFromUrl> & {
  contact: Props["reader"]["initialContact"];
  favorite?: boolean;
  notesPage?: Props["reader"]["initialNotesPage"];
};

/** The URL selects both the contact and the visible workspace level. */
export default function ContactsWorkspace(props: Props) {
  const locale = useLocale();
  const t = () => detailMessages.resolve([locale()]).t;
  const results = () => resultsMessages.resolve([locale()]).t;
  const [selection, setSelection] = createSignal<Selection>({
    contactId: props.reader.initialContactId,
    bookId: props.reader.initialBookId,
    contact: props.reader.initialContact,
    addressId: props.reader.initialAddressId ?? null,
    notesPage: props.reader.initialNotesPage,
  });
  const selected = () => Boolean(selection().contactId && selection().bookId);
  const listHref = () => {
    const url = new URL(props.list.resultHref, "http://contacts.local");
    for (const key of ["contact", "contactBook", "address", "contactOutcome"]) url.searchParams.delete(key);
    return `${url.pathname}${url.search}`;
  };

  onMount(() => {
    const sync = (event: Event) => {
      const { contactId, bookId, addressId } = getSelectedContactFromUrl();
      const payload = event.type === CONTACT_DETAIL_EVENT ? (event as CustomEvent<ContactDetailPayload>).detail : undefined;
      setSelection({
        contactId,
        bookId,
        addressId,
        contact: payload?.item ?? null,
        favorite: payload?.favorite,
      });
    };
    window.addEventListener(CONTACT_DETAIL_EVENT, sync);
    window.addEventListener("popstate", sync);
    onCleanup(() => {
      window.removeEventListener(CONTACT_DETAIL_EVENT, sync);
      window.removeEventListener("popstate", sync);
    });
  });

  return (
    <AppWorkspace.Main
      level={selected() ? "contacts-reader" : "contacts-list"}
      scroll={false}
      onLevelNavigate={() => clearSelectedContactInUrl()}
    >
      <AppWorkspace.MainPane
        id="contacts-list"
        label={props.list.title}
        description={props.list.description}
        href={listHref()}
        defaultSize={352}
        scroll={false}
        actions={
          <CreateContactButton
            writableBooks={props.list.writableBooks}
            defaultBookId={props.list.defaultCreateBookId}
            chooseBook={props.list.chooseBookOnCreate}
            label={results().newContact}
          />
        }
      >
        <ContactsWorkspaceMain {...props.list} />
      </AppWorkspace.MainPane>
      <AppWorkspace.MainPane id="contacts-reader" label={t().kindContact} open={selected()} scroll={false}>
        <ContactDetailPanel
          {...props.reader}
          initialContact={selection().contact}
          initialContactId={selection().contactId}
          initialBookId={selection().bookId}
          initialAddressId={selection().addressId}
          initialNotesPage={selection().notesPage}
          initialFavoriteKeys={
            selection().favorite === undefined
              ? props.reader.initialFavoriteKeys
              : [
                  ...props.reader.initialFavoriteKeys.filter((key) => key !== `${selection().bookId}:${selection().contactId}`),
                  ...(selection().favorite ? [`${selection().bookId}:${selection().contactId}`] : []),
                ]
          }
        />
      </AppWorkspace.MainPane>
    </AppWorkspace.Main>
  );
}
