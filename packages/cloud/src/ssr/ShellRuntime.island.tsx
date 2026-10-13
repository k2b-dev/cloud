import type { HelpDocumentManifest } from "@k2b/cloud/shared";
import {
  followPageTrail,
  installAppWorkspaceController,
  installPageTitleController,
  serializeAppWorkspaceLayoutState,
  useLocale,
} from "@k2b/ui";
import { createEffect, onCleanup, onMount } from "solid-js";
import { appWorkspaceCookieName, readAppWorkspaceLayoutCookie } from "../_internal/app-workspace-state";
import { registerContextAwareCommand } from "../browser/command-bridge";
import { attachCommandShortcuts } from "../browser/command-shortcuts";
import { navigationSearchItems } from "../browser/navigation-search";
import { importOnDemand } from "../browser/reload";
import { registerGlobalSearchHost } from "../browser/search-bridge";
import {
  ANNOUNCEMENTS_COOKIE,
  ANNOUNCEMENTS_COOKIE_MAX_AGE_SECONDS,
  mergeAnnouncementCookieState,
  parseAnnouncementCookieHeader,
  serializeAnnouncementCookieState,
} from "../contracts/announcement-cookie";
import type { AnnouncementDisplayEntry } from "../contracts/announcements";
import { createGlobalSearchHost } from "./global-search-host";
import { LayoutHelpDocuments } from "./layout-help-registry";
import { installPageTrailRuntime } from "./page-trail-runtime";
import { platformMessages } from "./platform-messages";
import { readShellData } from "./shell-data";
import { syncTimezoneCookie } from "./timezone-cookie";

export type ShellRuntimeProps = {
  /** Layout pages outside focus mode: keep the current app's workspace layout in its cookie. */
  workspace?: { appId?: string };
  /** Layout pages: page titles, the way up (Alt+Up) and its per-tab memory. */
  pageTrail?: boolean;
  /** The current app's Help documents. */
  help?: { documents: readonly HelpDocumentManifest[]; pageBase: string };
  /** Layout pages outside focus mode: the search host, Cmd/Ctrl+K, the Help command (Shift+/) and command shortcuts. */
  commands?: { searchResources: boolean };
  /** Signed-in pages: refresh this browser's push endpoint. */
  push?: boolean;
  /** Announcements the person has not seen yet; a dialog shows them once. */
  announcements?: { entries: AnnouncementDisplayEntry[]; latestVersion: number };
  /** Banners rendered by Layout: their dismiss buttons record the dismissal. */
  banners?: boolean;
};

/** The search rows of the shell's destinations; the page carries each link once, without the fields a row repeats. */
const searchItems = () => {
  const data = readShellData();
  if (!data) return [];
  const apps = Object.entries(data.searchLinks).flatMap(([id, searchLinks]) => {
    const app = data.apps.find((candidate) => candidate.id === id);
    return app ? [{ id, name: app.label, icon: app.iconClass, searchLinks }] : [];
  });
  return navigationSearchItems(
    apps,
    apps.map((app) => app.id),
  );
};

export default function ShellRuntime(props: ShellRuntimeProps) {
  const locale = useLocale();
  const t = () => platformMessages.resolve([locale()]).t;
  onMount(() => syncTimezoneCookie(true));

  if (props.workspace) {
    onMount(() => {
      const appId = props.workspace?.appId;
      onCleanup(
        installAppWorkspaceController({
          readState: () => readAppWorkspaceLayoutCookie(document.cookie, appId),
          writeState: (state) => {
            if (!appId) return;
            const secure = window.location.protocol === "https:" ? "; Secure" : "";
            document.cookie = `${appWorkspaceCookieName(appId)}=${serializeAppWorkspaceLayoutState(state)}; Path=/; Max-Age=31536000; SameSite=Lax${secure}`;
          },
        }),
      );
    });
  }
  if (props.pageTrail) {
    onMount(() => {
      const messages = t();
      const disposeTitles = installPageTitleController(document);
      const disposeFollow = followPageTrail(document);
      const disposeRuntime = installPageTrailRuntime((page) => ({
        title: messages.pageUp({ page }),
        description: messages.pageUpDescription,
      }));
      onCleanup(() => {
        disposeTitles();
        disposeFollow();
        disposeRuntime();
      });
    });
  }
  if (props.commands) {
    const host = createGlobalSearchHost(searchItems, props.commands.searchResources);
    onMount(() => onCleanup(registerGlobalSearchHost(host.open, host.dispose)));
    // Command schemas and the capability client load with the first shortcut.
    onMount(() =>
      onCleanup(
        attachCommandShortcuts(
          (command) =>
            void importOnDemand(() => import("../browser/commands")).then((commands) => commands?.runContextAwareCommand(command)),
        ),
      ),
    );
    createEffect(() =>
      onCleanup(
        registerContextAwareCommand({
          id: "cloud.search",
          title: t().openGlobalSearch,
          description: t().globalSearchDescription,
          icon: "ti ti-search",
          shortcut: "mod+k",
          action: { search: {} },
        }),
      ),
    );
    createEffect(() =>
      onCleanup(
        registerContextAwareCommand({
          id: "cloud.help",
          title: t().openShortcutHelp,
          description: t().shortcutHelpDescription,
          icon: "ti ti-help-circle",
          shortcut: "shift+/",
          // Returning the load keeps the Command busy until the dialog is open; a second press opens no second dialog.
          action: () => importOnDemand(() => import("./LayoutHelp")).then((help) => help?.openLayoutHelpDialog()),
        }),
      ),
    );
  }
  onMount(() => {
    if (props.push) {
      void import("../browser/notifications")
        .then(({ browserNotificationClient }) => browserNotificationClient.refreshExisting())
        .catch((error) => {
          console.warn("[notifications] Failed to refresh the browser endpoint", error);
        });
    }
    if (props.announcements?.entries.length) {
      const announcements = props.announcements;
      void importOnDemand(() => import("./announcements-dialog")).then((loaded) => loaded?.openAnnouncementsDialog(announcements));
    }
    if (props.banners) {
      const dismiss = (event: MouseEvent) => {
        if (!(event.target instanceof Element)) return;
        const button = event.target.closest<HTMLButtonElement>("[data-cloud-announcement-dismiss]");
        if (!button) return;
        const version = Number(button.dataset.cloudAnnouncementDismiss);
        const next = mergeAnnouncementCookieState(parseAnnouncementCookieHeader(document.cookie), { dismissedBannerVersions: [version] });
        document.cookie = `${ANNOUNCEMENTS_COOKIE}=${serializeAnnouncementCookieState(next)}; Path=/; Max-Age=${ANNOUNCEMENTS_COOKIE_MAX_AGE_SECONDS}; SameSite=Lax`;
        const banner = button.closest(".cloud-announcement");
        const list = banner?.parentElement;
        banner?.remove();
        if (list && !list.querySelector(".cloud-announcement")) list.remove();
      };
      document.addEventListener("click", dismiss);
      onCleanup(() => document.removeEventListener("click", dismiss));
    }
  });
  return props.help ? <LayoutHelpDocuments documents={props.help.documents} pageBase={props.help.pageBase} /> : null;
}
