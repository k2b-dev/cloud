import { refreshCurrentPath } from "@k2b/ssr/nav";
import { createNavigation, type NavigationItem, useLocale } from "@k2b/ui";
import { WorkspaceNavigationProvider } from "@k2b/cloud/ssr/islands";
import { createSignal } from "solid-js";
import { createContactsSearch, spotlightMessages } from "./contact-spotlight";
import { createBookController } from "./create-book";
import { openBookSettingsDialog } from "./BookSettingsDialog";
import { bookMessages } from "./book-messages";

export default function ContactsNavigation(props: { items: readonly NavigationItem[]; label: string }) {
  const locale = useLocale();
  const t = () => bookMessages.resolve([locale()]).t;
  const search = createContactsSearch();
  const book = createBookController();
  const [settingsOpen, setSettingsOpen] = createSignal(false);
  const navigation = createNavigation({
    items: () => [
      { id: "search", label: spotlightMessages.resolve([locale()]).t.searchContacts, icon: "ti ti-search", action: "search" },
      { id: "create", label: t().newBook, icon: "ti ti-plus", action: "create", disabled: book.busy() },
      ...props.items.map((item) => ({
        ...item,
        actions: item.actions?.map((action) => ({ ...action, disabled: settingsOpen() || action.disabled })),
      })),
    ],
    onAction: async (action) => {
      if (action === "search") return search();
      if (action === "create") return book.createBook();
      if (action.startsWith("settings:") && !settingsOpen()) {
        setSettingsOpen(true);
        try {
          const result = await openBookSettingsDialog({ bookId: action.slice("settings:".length) });
          if (result.workspaceChanged && !result.deleted) refreshCurrentPath();
        } finally {
          setSettingsOpen(false);
        }
      }
    },
  });
  return <WorkspaceNavigationProvider navigation={navigation} label={props.label} />;
}
