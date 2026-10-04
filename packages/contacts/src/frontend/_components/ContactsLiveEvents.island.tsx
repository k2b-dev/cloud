import { liveConnection } from "@k2b/cloud/browser/live";
import { reloadOnce } from "@k2b/cloud/browser/reload";
import { i18n } from "@k2b/stdlib";
import { toast, useLocale } from "@k2b/ui";
import { onCleanup, onMount } from "solid-js";
import { ContactLiveEventSchema } from "../../live-events";
import { dispatchContactsLiveInvalidation, requiresContactsShellRefresh } from "./contacts-live";
import { getSelectedContactFromUrl } from "./context";

type Props = {
  scope: { kind: "all" } | { kind: "book"; bookId: string };
  initialCursor: string | null;
};

const ACTIVE_EDITOR_SELECTOR = '[data-contacts-editor="true"]';

export const liveEventsMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      liveUpdatesStopped: "Live updates stopped. Reload the page to see the latest changes.",
      reload: "Reload",
    },
    de: {
      liveUpdatesStopped: "Live-Aktualisierungen wurden beendet. Lade die Seite neu, um die neuesten Änderungen zu sehen.",
      reload: "Neu laden",
    },
  },
});

const waitForEditorsToClose = (signal: AbortSignal): Promise<void> => {
  if (!document.querySelector(ACTIVE_EDITOR_SELECTOR)) return Promise.resolve();
  return new Promise((resolve) => {
    const observer = new MutationObserver(() => {
      if (document.querySelector(ACTIVE_EDITOR_SELECTOR)) return;
      observer.disconnect();
      signal.removeEventListener("abort", abort);
      resolve();
    });
    const abort = () => {
      observer.disconnect();
      resolve();
    };
    signal.addEventListener("abort", abort, { once: true });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-contacts-editor"] });
  });
};

export default function ContactsLiveEvents(props: Props) {
  const locale = useLocale();
  const t = () => liveEventsMessages.resolve([locale()]).t;
  onMount(() => {
    const lifecycle = new AbortController();
    let reloading = false;

    // A condition that persists across loads (for example a live socket that
    // keeps rejecting the session) must not reload the page forever.
    const replaceCurrentPage = () => {
      if (reloading || lifecycle.signal.aborted) return;
      reloading = true;
      lifecycle.abort();
      subscription.close();
      if (reloadOnce(`contacts:live:${window.location.pathname}`)) return;
      toast(t().liveUpdatesStopped, { duration: 0, action: { label: t().reload, onClick: () => window.location.reload() } });
    };

    /** Book names, tags, and access shape the whole page: load it again once no editor is open. */
    const reloadPage = async () => {
      await waitForEditorsToClose(lifecycle.signal);
      replaceCurrentPage();
    };

    const getCurrentSelection = () => {
      const selection = getSelectedContactFromUrl();
      if (selection.contactId && !selection.bookId && props.scope.kind === "book") {
        return { ...selection, bookId: props.scope.bookId };
      }
      return selection;
    };

    const scope = props.scope;
    const subscription = liveConnection("/api/contacts/live").subscribe(scope.kind, scope.kind === "book" ? { book: scope.bookId } : {}, {
      cursor: props.initialCursor,
      parse: (data) => ContactLiveEventSchema.parse(data),
      apply: async (events) => {
        for (const { data: event } of events) {
          if (reloading) return;
          if (requiresContactsShellRefresh(event)) return reloadPage();
          await dispatchContactsLiveInvalidation(event, getCurrentSelection());
        }
      },
      resync: reloadPage,
      revoked: replaceCurrentPage,
      unavailable: () => void reloadPage(),
    });

    onCleanup(() => {
      lifecycle.abort();
      subscription.close();
    });
  });

  return null;
}
