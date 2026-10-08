import { AppWorkspace, createNavigation, LocaleProvider, Navigation, type NavigationItem } from "@k2b/ui";
import { render } from "solid-js/web";
import { handleSoftNoteNavigationRequests } from "../../../lib/soft-navigation";
import { NOTE_SOFT_NAVIGATED_EVENT } from "../detail/events";
import NotebookNavigatorPane from "./NotebookNavigatorPane.island";
import NotebookSidebar from "./NotebookSidebar.island";
import type { NotebookContext } from "./types";

/**
 * The real notebook sidebar and note list in the workspace layout of the notebook page. The editor is a stand-in that
 * applies every soft navigation, as the real one does, and records where it went.
 */
declare global {
  interface Window {
    mountNotebookSidebar: (ctx: NotebookContext, locale: string) => void;
    /** Renders the phone menu from the items the sidebar hands to Cloud's header, like the Cloud layout does. */
    mountPhoneMenu: (locale: string, live?: boolean) => void;
    openedNotes: string[];
  }
}

window.openedNotes = [];

window.mountNotebookSidebar = (ctx, locale) => {
  const host = document.getElementById("root");
  if (!host) throw new Error("Missing harness root");
  document.documentElement.lang = locale;
  handleSoftNoteNavigationRequests(async (href) => {
    const noteId = /\/notes\/(\w+)/u.exec(href)?.[1];
    window.openedNotes.push(href);
    window.history.pushState({}, "", href);
    window.dispatchEvent(new CustomEvent(NOTE_SOFT_NAVIGATED_EVENT, { detail: { noteId } }));
    return { kind: "applied", href };
  });
  render(
    () => (
      <LocaleProvider locale={locale}>
        <AppWorkspace mobileSurface="flush" class="flex-1 min-h-0">
          <NotebookSidebar ctx={ctx} />
          <AppWorkspace.Content>
            <AppWorkspace.Main scroll={false}>
              {ctx.settings.sidebarMode === "navigator" && (
                <AppWorkspace.MainPane
                  id="notebook-notes"
                  label="Notes"
                  surface="navigation"
                  defaultSize={336}
                  minSize={280}
                  maxSize={520}
                  scroll={false}
                >
                  <NotebookNavigatorPane ctx={ctx} />
                </AppWorkspace.MainPane>
              )}
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
  render(
    () => (
      <LocaleProvider locale={locale}>
        <Navigation navigation={navigation} label={label} />
      </LocaleProvider>
    ),
    host,
  );
};
