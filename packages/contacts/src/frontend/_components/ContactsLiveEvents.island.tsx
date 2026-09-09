import { currentPathWithQuery } from "@k2b/ssr/nav";
import { i18n } from "@k2b/stdlib";
import { retry } from "@k2b/sync/retry";
import { useLocale } from "@k2b/ui";
import { createLiveWebSocket } from "@k2b/cloud/browser/live";
import { onCleanup, onMount } from "solid-js";
import {
  CONTACTS_LIVE_WS_TYPE,
  type ContactLiveClientMessage,
  type ContactLiveScope,
  type ContactLiveServerMessage,
  parseContactLiveServerMessage,
} from "../../live-events";
import { createContactsLiveApplyQueue, dispatchContactsLiveInvalidation, requiresContactsShellRefresh } from "./contacts-live";
import { getSelectedContactFromUrl } from "./context";

type Props = {
  scope: ContactLiveScope;
  initialCursor: string | null;
};

const ACTIVE_EDITOR_SELECTOR = '[data-contacts-editor="true"]';

export const liveEventsMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      bookMetadataChanged: "Contact book metadata changed",
      updateNotApplied: "Could not apply a Contacts update",
      liveAccessChanged: "Live access changed or expired.",
      bookAccessChanged: "Contact book access changed",
    },
    de: {
      bookMetadataChanged: "Kontaktbuch geändert",
      updateNotApplied: "Eine Änderung in Kontakte konnte nicht übernommen werden",
      liveAccessChanged: "Der Zugriff wurde geändert oder ist abgelaufen.",
      bookAccessChanged: "Zugriff auf das Kontaktbuch geändert",
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

    const replaceCurrentPage = () => {
      if (reloading || lifecycle.signal.aborted) return;
      reloading = true;
      lifecycle.abort();
      window.location.replace(currentPathWithQuery());
    };

    const getCurrentSelection = () => {
      const selection = getSelectedContactFromUrl();
      if (selection.contactId && !selection.bookId && props.scope.kind === "book") {
        return { ...selection, bookId: props.scope.bookId };
      }
      return selection;
    };

    const applyQueue = createContactsLiveApplyQueue({
      apply: async (event, controls) => {
        if (reloading || lifecycle.signal.aborted) return false;
        if (requiresContactsShellRefresh(event)) {
          controls.terminate({ code: "shell_changed", message: t().bookMetadataChanged });
          await waitForEditorsToClose(lifecycle.signal);
          replaceCurrentPage();
          return false;
        }
        await retry({
          signal: lifecycle.signal,
          run: () => dispatchContactsLiveInvalidation(event, getCurrentSelection()),
          after: ({ ctx }) => {
            if (ctx.error && ctx.attempt < 3) ctx.reschedule({ delayMs: ctx.expBackoff({ baseMs: 150, maxMs: 1_000 }) });
          },
        });
      },
      onFailure: async (_error, controls) => {
        controls.terminate({ code: "refresh_failed", message: t().updateNotApplied });
        await waitForEditorsToClose(lifecycle.signal);
        replaceCurrentPage();
      },
    });

    const connection = createLiveWebSocket<ContactLiveServerMessage>({
      url: "/api/contacts/ws",
      initialCursor: props.initialCursor,
      activity: "visible",
      subscribe: (cursor) =>
        ({
          type: CONTACTS_LIVE_WS_TYPE.subscribe,
          payload: { scope: props.scope, fromCursor: cursor },
        }) satisfies ContactLiveClientMessage,
      parse: parseContactLiveServerMessage,
      classifyClose: ({ code, reason }) => (code === 1008 ? { code: reason || "access_denied", message: t().liveAccessChanged } : null),
      onMessage: (message, controls) => {
        if (message.type === CONTACTS_LIVE_WS_TYPE.error && message.payload.code === "resync_required") {
          controls.terminate({ code: message.payload.code, message: message.payload.message });
          void waitForEditorsToClose(lifecycle.signal).then(replaceCurrentPage);
          return;
        }
        if (message.type === CONTACTS_LIVE_WS_TYPE.ready) {
          controls.markApplied(message.payload.cursor);
          return;
        }
        if (message.type === CONTACTS_LIVE_WS_TYPE.scopeChanged) {
          controls.terminate({ code: "scope_changed", message: t().bookAccessChanged });
          if (message.payload.change === "gained") {
            void waitForEditorsToClose(lifecycle.signal).then(replaceCurrentPage);
          } else {
            replaceCurrentPage();
          }
          return;
        }
        if (message.type === CONTACTS_LIVE_WS_TYPE.event) {
          void applyQueue.enqueue(message.payload.event, message.payload.cursor, controls);
          return;
        }
        if (message.type === CONTACTS_LIVE_WS_TYPE.revoked) {
          controls.terminate({ code: message.payload.code, message: message.payload.message });
          replaceCurrentPage();
        }
      },
    });

    connection.connect();
    onCleanup(() => {
      applyQueue.stop();
      lifecycle.abort();
      connection.dispose();
    });
  });

  return null;
}
