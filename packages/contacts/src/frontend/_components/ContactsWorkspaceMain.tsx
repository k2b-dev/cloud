import { AppWorkspace } from "@k2b/ui";
import type { Contact, ContactTag } from "../../service";
import ContactsResults from "./ContactsResults.island";
import type { ContactsScope } from "./contacts-empty-state";

type ContactBookOption = {
  id: string;
  name: string;
};

export type ContactsWorkspaceMainProps = {
  scope: ContactsScope;
  total: number;
  resultHref: string;
  bookId?: string;
  perPage: number;
  contacts: Contact[];
  bookNames: Record<string, string>;
  showBookNames?: boolean;
  initialSelectedContactId: string | null;
  initialSelectedBookId: string | null;
  writableBooks: ContactBookOption[];
  currentPage: number;
  totalPages: number;
  tags?: ContactTag[];
  initialFavoriteKeys: string[];
};

export default function ContactsWorkspaceMain(props: ContactsWorkspaceMainProps) {
  return (
    <AppWorkspace.Main scroll={false} minWidth={368}>
      <ContactsResults
        scope={props.scope}
        bookId={props.bookId}
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
        tags={props.tags}
        initialFavoriteKeys={props.initialFavoriteKeys}
        canWrite={Boolean(props.bookId && props.writableBooks.some((book) => book.id === props.bookId))}
        writableBooks={props.writableBooks}
      />
    </AppWorkspace.Main>
  );
}
