import type { HelpDocumentManifest } from "@k2b/cloud/shared";
import {
  followPageTrail,
  installAppWorkspaceController,
  installInputModeController,
  installPageTitleController,
  keyboardPlatform,
  serializeAppWorkspaceLayoutState,
  useLocale,
} from "@k2b/ui";
import { createEffect, createSignal, onCleanup, onMount } from "solid-js";
import { appWorkspaceCookieName, readAppWorkspaceLayoutCookie } from "../_internal/app-workspace-state";
import { registerContextAwareCommand } from "../browser/command-bridge";
import { attachCommandShortcuts } from "../browser/command-shortcuts";
import { navigationSearchItems } from "../browser/navigation-search";
import type { PanelRequest } from "../browser/panel";
import { importOnDemand } from "../browser/reload";
import { registerGlobalSearchHost } from "../browser/search-bridge";
import { attachShellFocusControls, readShellFocus, SHELL_FOCUS_CHANGE_EVENT, toggleShellFocus } from "../browser/shell-focus";
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
import { shellShortcuts } from "./shell-shortcuts";
import { syncTimezoneCookie } from "./timezone-cookie";

export type ShellRuntimeProps = {
  /** This page has an authorized panel slot. */
  panel?: boolean;
  /** Layout pages outside focus mode: keep the current app's workspace layout in its cookie. */
  workspace?: { appId?: string };
  /** Layout pages: page titles, the way up (Alt+Up) and its per-tab memory. */
  pageTrail?: boolean;
  /** The current app's Help documents. */
  help?: { documents: readonly HelpDocumentManifest[]; pageBase: string };
  /** Layout pages outside focus mode: the search host, Cmd/Ctrl+K, the Help command (Shift+/) and command shortcuts. */
  commands?: { searchResources: boolean };
  /** Signed-in Layout pages: the sidebar buttons, Cmd/Ctrl+\ and the left-edge drag hide and show the app bar and the app's navigation. */
  focus?: boolean;
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
  onMount(() => onCleanup(installInputModeController()));

  const togglePanel = () => {
    window.dispatchEvent(new CustomEvent<PanelRequest>("cloud.panel.request", { detail: { action: "toggle" } }));
  };
  if (props.panel) {
    onMount(() => {
      let stopped = false;
      let dispose: (() => void) | undefined;
      const load = async (request?: PanelRequest) => {
        const panel = await importOnDemand(() => import("../browser/panel-slot"));
        if (!panel || stopped) return;
        dispose ??= panel.installPanelSlot();
        if (request) panel.handlePanelRequest(request);
      };
      const request = (event: CustomEvent<PanelRequest>) => {
        const detail = event.detail;
        if (detail.action === "open") {
          if (detail.accepted || !readShellData()?.panel?.providers.some((provider) => provider.id === detail.provider)) return;
          detail.accepted = true;
        }
        void load(event.detail);
      };
      const key = (event: KeyboardEvent) => {
        const apple = keyboardPlatform() === "apple";
        if (
          event.defaultPrevented ||
          event.isComposing ||
          event.repeat ||
          event.altKey ||
          event.shiftKey ||
          event.key.toLowerCase() !== "j" ||
          event.metaKey !== apple ||
          event.ctrlKey !== !apple
        )
          return;
        event.preventDefault();
        togglePanel();
      };
      // The panel controller loads lazily; it reads this mark to recheck consent after a restore it did not see.
      const restored = (event: PageTransitionEvent) => {
        if (event.persisted) document.documentElement.setAttribute("data-cloud-page-restored", "");
      };
      window.addEventListener("pageshow", restored);
      window.addEventListener("cloud.panel.request", request);
      if (!props.commands) window.addEventListener("keydown", key);
      if (document.querySelector('.cloud-app-canvas[data-panel="open"]')) void load();
      onCleanup(() => {
        stopped = true;
        dispose?.();
        window.removeEventListener("pageshow", restored);
        window.removeEventListener("cloud.panel.request", request);
        window.removeEventListener("keydown", key);
      });
    });
  }

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
  if (props.focus) {
    const [hidden, setHidden] = createSignal(false);
    const [available, setAvailable] = createSignal(false);
    onMount(() => {
      setHidden(readShellFocus());
      const media = window.matchMedia("(min-width: 768px)");
      const resize = () => setAvailable(media.matches);
      const change = (event: Event) => setHidden((event as CustomEvent<{ hidden: boolean }>).detail.hidden);
      const dispose = attachShellFocusControls();
      resize();
      media.addEventListener("change", resize);
      window.addEventListener(SHELL_FOCUS_CHANGE_EVENT, change);
      onCleanup(() => {
        dispose();
        media.removeEventListener("change", resize);
        window.removeEventListener(SHELL_FOCUS_CHANGE_EVENT, change);
      });
    });
    createEffect(() => {
      if (!available()) return;
      onCleanup(
        registerContextAwareCommand({
          id: "cloud.shell.focus",
          title: hidden() ? t().showSidebar : t().hideSidebar,
          description: t().sidebarCommandDescription,
          icon: hidden() ? "ti ti-layout-sidebar-left-expand" : "ti ti-layout-sidebar-left-collapse",
          shortcut: "mod+\\",
          action: toggleShellFocus,
        }),
      );
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
    createEffect(() => {
      for (const command of shellShortcuts(t(), { panel: props.panel })) {
        onCleanup(
          registerContextAwareCommand({
            ...command,
            action:
              command.id === "cloud.panel"
                ? togglePanel
                : command.id === "cloud.search"
                  ? { search: {} }
                  : // Returning the load keeps the Command busy until the dialog is open; a second press opens no second dialog.
                    () => importOnDemand(() => import("./LayoutHelp")).then((help) => help?.openLayoutHelpDialog()),
          }),
        );
      }
    });
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
