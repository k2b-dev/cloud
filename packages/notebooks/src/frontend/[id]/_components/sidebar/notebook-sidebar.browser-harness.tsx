import { AppWorkspace, createNavigation, LocaleProvider, Navigation, type NavigationItem } from "@k2b/ui";
import { render } from "solid-js/web";
import { handleSoftNoteNavigationRequests, requestSoftNoteNavigation } from "../../../lib/soft-navigation";
import { NOTE_SOFT_NAVIGATED_EVENT } from "../detail/events";
import NotebookSidebar from "./NotebookSidebar.island";
import type { NotebookContext } from "./types";

/**
 * The real notebook sidebar in the workspace layout of the notebook page. The editor is a stand-in that takes clicks
 * on note links and applies every soft navigation, as the real one does, and records where it went.
 */
declare global {
  interface Window {
    mountNotebookSidebar: (ctx: NotebookContext, locale: string) => void;
    /** Renders the phone menu from the items the sidebar hands to Cloud's header, like the Cloud layout does. */
    mountPhoneMenu: (locale: string, live?: boolean) => void;
    /** Whether a selection closed the phone menu, as Cloud's menu closes before it runs one. */
    phoneMenuClosed: boolean;
    openedNotes: string[];
  }
}

window.openedNotes = [];
document.addEventListener("click", (event) => {
  const anchor = (event.target as Element | null)?.closest<HTMLAnchorElement>('a[href*="/notes/"]');
  if (!anchor || event.defaultPrevented || event.button !== 0) return;
  event.preventDefault();
  void requestSoftNoteNavigation(anchor.getAttribute("href")!);
});

window.mountNotebookSidebar = (ctx, locale) => {
  const host = document.getElementById("root");
  if (!host) throw new Error("Missing harness root");
  document.documentElement.lang = locale;
  // In the editor's order: the note applies and announces itself, and only then does the history show its address.
  handleSoftNoteNavigationRequests(async (href, { push }) => {
    const noteId = /\/notes\/(\w+)/u.exec(href)?.[1];
    window.openedNotes.push(href);
    window.dispatchEvent(new CustomEvent(NOTE_SOFT_NAVIGATED_EVENT, { detail: { noteId, href } }));
    if (push) window.history.pushState({}, "", href);
    return { kind: "applied", href };
  });
  render(
    () => (
      <LocaleProvider locale={locale}>
        <AppWorkspace mobileSurface="flush" class="notebooks-workspace flex-1 min-h-0">
          <NotebookSidebar ctx={ctx} />
          <AppWorkspace.Content>
            <AppWorkspace.Main scroll={false}>
              <div class="notebook-document-surface flex flex-1 min-w-0 min-h-0 flex-col" />
            </AppWorkspace.Main>
          </AppWorkspace.Content>
        </AppWorkspace>
      </LocaleProvider>
    ),
    host,
  );
};

/** `live` uses the sidebar's own navigation, as Cloud's header does once the island runs, so actions work. */
window.mountPhoneMenu = (locale, live = false) => {
  const script = document.querySelector<HTMLScriptElement>("script[data-cloud-workspace-navigation]");
  const { label, items } = JSON.parse(script?.textContent ?? "{}") as { label: string; items: NavigationItem[] };
  const host = document.getElementById("phone-menu");
  if (!host) throw new Error("Missing phone menu root");
  const navigation =
    live && window.__cloudWorkspaceNavigation ? window.__cloudWorkspaceNavigation.navigation : createNavigation({ items: () => items });
  window.phoneMenuClosed = false;
  const close = render(
    () => (
      <LocaleProvider locale={locale}>
        <Navigation
          navigation={navigation}
          label={label}
          beforeSelect={() => {
            window.phoneMenuClosed = true;
            close();
          }}
        />
      </LocaleProvider>
    ),
    host,
  );
};
