import { AppWorkspace } from "@k2b/ui";
import type { Scenario } from "./ContactAddressGeo.browser-fixture";
import ContactDetailPanel from "./ContactDetailPanel.island";
import ContactsSidebar from "./ContactsSidebar";
import ContactsWorkspaceMain from "./ContactsWorkspaceMain";
import DesktopDetailLayoutSync from "./DesktopDetailLayoutSync.island";

/** Real page composition with fictional data and stub APIs; no standalone editor. */
export default function ContactAddressWorkspace(props: { scenario: Scenario }) {
  const contact = () => props.scenario.contact;
  const contacts = () => props.scenario.contacts ?? [contact()];
  const writableBooks = () => (props.scenario.readonly ? [] : [{ id: "team", name: "Kunden" }]);
  return (
    <AppWorkspace mobileSurface="flush">
      <ContactsSidebar
        books={[{ id: "team", name: "Kunden", description: null, createdAt: contact().createdAt, updatedAt: contact().updatedAt }]}
        active="team"
      />
      <AppWorkspace.Content>
        <ContactsWorkspaceMain
          scope="book"
          title="Kunden"
          description="Fiktive Kontakte"
          total={contacts().length}
          search={new URL(props.scenario.href ?? "/", "http://contacts.test").searchParams.get("search") ?? ""}
          resultHref={props.scenario.href ?? "/"}
          bookId="team"
          perPage={30}
          searchPlaceholder="Kontakte filtern"
          contacts={contacts()}
          bookNames={{ team: "Kunden" }}
          initialSelectedContactId={contact().id}
          initialSelectedBookId={contact().bookId}
          writableBooks={writableBooks()}
          defaultCreateBookId="team"
          currentPage={1}
          totalPages={1}
          initialFavoriteKeys={[]}
        />
        <AppWorkspace.Detail
          id="contacts-detail-panel"
          open
          width="lg"
          maxWidth={760}
          phone={props.scenario.initialAddressId ? "page" : "sheet"}
        >
          <ContactDetailPanel
            initialContact={contact()}
            initialContactId={contact().id}
            initialBookId={contact().bookId}
            initialAddressId={props.scenario.initialAddressId}
            initialNotesPage={{ items: [], page: 1, perPage: 30, total: 0, hasNext: false }}
            contacts={contacts()}
            bookNames={{ team: "Kunden" }}
            writableBooks={writableBooks()}
            adminBookIds={[]}
            currentUserId="user-1"
            showEmpty={false}
            initialFavoriteKeys={[]}
            geoAvailability={props.scenario.availability}
            timeZone="Europe/Berlin"
          />
        </AppWorkspace.Detail>
      </AppWorkspace.Content>
      <DesktopDetailLayoutSync detailPanelId="contacts-detail-panel" />
    </AppWorkspace>
  );
}
