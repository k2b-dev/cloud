import { AppWorkspace } from "@k2b/ui";
import type { Contact, ContactTag } from "../../service";
import ContactsResults from "./ContactsResults.island";
import CreateContactButton from "./CreateContactButton.island";

type ContactBookOption = {
  id: string;
  name: string;
};

type Props = {
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
    <AppWorkspace.Main scroll={false}>
      <header class="flex shrink-0 flex-col gap-3 px-3 py-3 sm:px-4">
        <div class="flex min-w-0 items-start justify-between gap-3">
          <div class="min-w-0">
            <h1 class="truncate text-base font-semibold text-primary">{props.title}</h1>
            <p class="mt-0.5 truncate text-xs text-dimmed">{props.description}</p>
          </div>
          <CreateContactButton
            writableBooks={props.writableBooks}
            defaultBookId={props.defaultCreateBookId}
            chooseBook={props.chooseBookOnCreate}
            label="New contact"
          />
        </div>
      </header>

      <ContactsResults
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
    </AppWorkspace.Main>
  );
}
