import type { Contact, ContactTag } from "../../service";
import ContactsResults from "./ContactsResults";
import type { ContactsScope } from "./contacts-empty-state";

type ContactBookOption = {
  id: string;
  name: string;
};

type Props = {
  scope: ContactsScope;
  title: string;
  description: string;
  total: number;
  search: string;
  resultHref: string;
  bookId?: string;
  perPage: number;
  searchPlaceholder: string;
  contacts: Contact[];
  bookNames: Record<string, string>;
  showBookNames?: boolean;
  initialSelectedContactId: string | null;
  initialSelectedBookId: string | null;
  writableBooks: ContactBookOption[];
  defaultCreateBookId: string | null;
  chooseBookOnCreate?: boolean;
  currentPage: number;
  totalPages: number;
  tags?: ContactTag[];
  activeTagId?: string | null;
  filtersBasePath?: string;
  initialFavoriteKeys: string[];
};

export default function ContactsWorkspaceMain(props: Props) {
  return (
    <ContactsResults
      scope={props.scope}
      bookId={props.bookId}
      initialSearch={props.search}
      initialHref={props.resultHref}
      initialContacts={props.contacts}
      initialTotal={props.total}
      initialPage={props.currentPage}
      initialTotalPages={props.totalPages}
      perPage={props.perPage}
      bookNames={props.bookNames}
      showBookNames={props.showBookNames}
      initialSelectedContactId={props.initialSelectedContactId}
      initialSelectedBookId={props.initialSelectedBookId}
      searchPlaceholder={props.searchPlaceholder}
      tags={props.tags}
      activeTagId={props.activeTagId}
      filtersBasePath={props.filtersBasePath}
      initialFavoriteKeys={props.initialFavoriteKeys}
      canWrite={Boolean(props.bookId && props.writableBooks.some((book) => book.id === props.bookId))}
      writableBooks={props.writableBooks}
    />
  );
}
