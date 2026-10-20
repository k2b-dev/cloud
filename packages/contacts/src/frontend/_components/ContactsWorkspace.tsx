import { AppWorkspace, useLocale } from "@k2b/ui";
import type { ComponentProps, JSX } from "solid-js";
import { contactsViewHref } from "../contacts-query";
import ContactDetailPanel from "./ContactDetailPanel.island";
import ContactsHeadActions from "./ContactsHeadActions.island";
import ContactsHeadFilters from "./ContactsHeadFilters.island";
import ContactsSidebar from "./ContactsSidebar";
import ContactsViewTabs from "./ContactsViewTabs.island";
import ContactsWorkspaceMain, { type ContactsWorkspaceMainProps } from "./ContactsWorkspaceMain";
import { contactsPrimaryHref } from "./contacts-primary";
import { resultsMessages } from "./results-messages";

type DetailProps = ComponentProps<typeof ContactDetailPanel>;
export type ContactsWorkspaceProps = ContactsWorkspaceMainProps & {
  books: ComponentProps<typeof ContactsSidebar>["books"];
  adminBookIds: string[];
  currentUserId: string;
  initialContact: DetailProps["initialContact"];
  initialNotesPage: DetailProps["initialNotesPage"];
  searchPlaceholder: string;
  allCount: number;
  favoritesCount: number;
  favoritesHintOpen?: boolean;
  /** Keep the book page's existing launcher placement inside the mounted Detail. */
  detailLauncher?: JSX.Element;
};

/** Plain projected data only: the same workspace can render in a standalone browser fixture. */
export default function ContactsWorkspace(props: ContactsWorkspaceProps) {
  const locale = useLocale();
  const t = () => resultsMessages.resolve([locale()]).t;
  const canWrite = Boolean(props.bookId && props.writableBooks.some((book) => book.id === props.bookId));
  return (
    <AppWorkspace mobileSurface="flush">
      <ContactsSidebar
        books={props.books}
        active={props.bookId ?? "all"}
        adminBookIds={props.adminBookIds}
        favoritesHref={contactsViewHref(new URL(props.resultHref, "http://contacts.local").pathname, true)}
        hintOpen={props.favoritesHintOpen}
      />
      <AppWorkspace.Head
        views={
          <ContactsViewTabs
            initialHref={props.resultHref}
            bookId={props.bookId}
            allCount={props.allCount}
            favoritesCount={props.favoritesCount}
          />
        }
        filters={
          <ContactsHeadFilters
            initialHref={props.resultHref}
            initialTotal={props.total}
            searchPlaceholder={props.searchPlaceholder}
            tags={props.tags ?? []}
            bookNames={props.bookNames}
            showBookNames={props.showBookNames}
          />
        }
        actions={
          <ContactsHeadActions
            bookId={props.bookId}
            canWrite={canWrite}
            canManage={Boolean(props.bookId && props.adminBookIds.includes(props.bookId))}
            initialHref={props.resultHref}
          />
        }
        primary={
          props.writableBooks.length
            ? {
                label: t().newContact,
                icon: "ti ti-user-plus",
                href: contactsPrimaryHref(props.resultHref, canWrite ? props.bookId : undefined),
              }
            : undefined
        }
      />
      <AppWorkspace.Content>
        <ContactsWorkspaceMain {...props} />
        <AppWorkspace.Detail
          id="contacts-detail-panel"
          open={Boolean(props.initialContact)}
          width="lg"
          phone="page"
          viewTransitionName="contacts-detail-panel-shell"
        >
          {props.detailLauncher}
          <ContactDetailPanel
            initialContact={props.initialContact}
            initialContactId={props.initialSelectedContactId}
            initialBookId={props.initialSelectedBookId}
            initialNotesPage={props.initialNotesPage}
            contacts={props.contacts}
            bookNames={props.bookNames}
            writableBooks={props.writableBooks}
            adminBookIds={props.adminBookIds}
            currentUserId={props.currentUserId}
            showEmpty={false}
            initialFavoriteKeys={props.initialFavoriteKeys}
          />
        </AppWorkspace.Detail>
      </AppWorkspace.Content>
    </AppWorkspace>
  );
}
