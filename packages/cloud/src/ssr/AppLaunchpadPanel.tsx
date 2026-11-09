import { documentNavigate } from "@k2b/ssr/nav";
import { IconButton, ScrollArea, TextInput, useLocale } from "@k2b/ui";
import { createMemo, createSignal, For, type JSX, Show } from "solid-js";
import { Dynamic } from "solid-js/web";
import { importOnDemand } from "../browser/reload";
import type { CloudThemePreference } from "../shared/theme";
import { AppBadge, useAppBadgeDescription } from "./AppBadge";
import { appIconStyle } from "./app-icon-style";
import { MobileProfileActions } from "./MobileProfileActions";
import { platformMessages } from "./platform-messages";
import { readRailContext } from "./rail-context";
import { railMessages } from "./rail-messages";
import { projectRailNavigation } from "./rail-navigation";

export type AppLaunchpadApp = {
  id: string;
  iconClass: string;
  label: string;
  href: string;
  description?: string;
  accent?: string;
  /** The app's `nav.badge` endpoint. */
  badge?: string;
};

export type AppLaunchpadLegalLink = {
  label: string;
  href: string;
  icon?: string;
};

export type AppLaunchpadContext = {
  profile?: { userId?: string; name: string; theme: CloudThemePreference; appHref?: string };
  apps: AppLaunchpadApp[];
  legalLinks: AppLaunchpadLegalLink[];
};

type LaunchpadTile = AppLaunchpadApp & { appId?: string; start?: boolean };

export const AppLaunchpadPanel = (
  props: AppLaunchpadContext & { close: () => void; beforeSelect?: () => Promise<boolean>; surface?: "panel" | "sheet" },
) => {
  const locale = useLocale();
  const t = () => railMessages.resolve([locale()]).t;
  const rail = readRailContext();
  const [query, setQuery] = createSignal("");
  const [editorLoading, setEditorLoading] = createSignal(false);
  const messages = () => platformMessages.resolve([locale()]).t;
  const matches = (label: string, description = "") =>
    `${label} ${description}`.toLocaleLowerCase(locale()).includes(query().trim().toLocaleLowerCase(locale()));
  // One grid: pinned entries are ordinary tiles that come first, in their pinned order, and a pinned app is not
  // repeated among the others. A signed-in phone has no rail and no Home button in its title row: Start leads there.
  const allTiles = createMemo((): LaunchpadTile[] => {
    const pinned = rail ? projectRailNavigation(rail.apps, rail.settings, locale()).shortcuts : [];
    const pinnedApps = new Set(pinned.flatMap((entry) => (entry.appId ? [entry.appId] : [])));
    return [
      ...(props.surface === "sheet" && props.profile
        ? [{ id: "home", label: messages().home, href: "/", iconClass: "ti ti-home", start: true }]
        : []),
      // A pinned app keeps its app's colour; a link takes the tone of its own id, as an app without an accent does.
      ...pinned.map((entry) => ({ ...entry, id: entry.appId ?? entry.id })),
      ...props.apps.filter((app) => !pinnedApps.has(app.id)).map((app) => ({ ...app, appId: app.id })),
    ];
  });
  const tiles = () => allTiles().filter((tile) => matches(tile.label, tile.description));
  const follow: JSX.EventHandler<HTMLAnchorElement, MouseEvent> = (event) => {
    if (!props.beforeSelect || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    const href = event.currentTarget.href;
    void props.beforeSelect().then((allowed) => {
      if (allowed) documentNavigate(href);
    });
  };
  return (
    <Dynamic
      component={props.surface === "sheet" ? "div" : ScrollArea}
      class={
        props.surface === "sheet"
          ? "cloud-mobile-apps"
          : "launchpad-panel mx-auto max-h-[min(86vh,var(--ui-dialog-available-height))] w-[var(--ui-dialog-available-width)] max-w-[var(--ui-dialog-available-width)] overscroll-contain p-4 text-primary sm:w-fit sm:p-6 md:p-7 dark:text-white"
      }
    >
      <div class="launchpad-tools">
        <Show when={props.surface === "sheet"}>
          <TextInput
            value={query}
            onValueChange={setQuery}
            icon="ti ti-search"
            clearable
            placeholder={messages().findApps}
            aria-label={messages().findApps}
          />
        </Show>
        <Show when={rail}>
          <div class="launchpad-customize mb-2 flex justify-end">
            <IconButton
              variant="ghost"
              size="sm"
              label={t().customize}
              tooltip={t().customize}
              tooltipDelay={0}
              aria-busy={editorLoading() ? "true" : undefined}
              onClick={async () => {
                if (editorLoading()) return;
                // The editor and its validation load only when someone customizes the app bar, while this panel
                // stays open and shows that it is busy. The button stays enabled so it keeps focus.
                setEditorLoading(true);
                const editor = await importOnDemand(() => import("./RailEditor"));
                setEditorLoading(false);
                if (!editor) return;
                if (props.beforeSelect) {
                  if (!(await props.beforeSelect())) return;
                } else props.close();
                editor.openRailEditor(locale());
              }}
            >
              <i class={editorLoading() ? "ti ti-loader-2 animate-spin" : "ti ti-adjustments-horizontal"} aria-hidden="true" />
            </IconButton>
          </div>
        </Show>
      </div>
      <div class="launchpad-apps-grid flex flex-wrap justify-center gap-x-4 gap-y-4 sm:gap-x-7 sm:gap-y-6">
        <For each={tiles()}>
          {(tile) => {
            const badge = useAppBadgeDescription(() => ({ endpoint: tile.badge, appId: tile.appId }));
            return (
              <a
                onClick={follow}
                href={tile.href}
                data-cloud-launchpad-start={tile.start ? "" : undefined}
                class="launchpad-app group flex w-[4.75rem] min-w-0 flex-col items-center gap-1.5 rounded-2xl p-1 text-center focus-ui sm:w-[6.25rem] sm:gap-2 sm:p-2"
              >
                <span
                  class="app-icon relative grid h-12 w-12 place-items-center rounded-[0.95rem] text-[1.25rem] sm:h-16 sm:w-16 sm:rounded-[1.25rem] sm:text-[1.7rem]"
                  style={appIconStyle(tile)}
                >
                  <i class={tile.iconClass} aria-hidden="true" />
                  <AppBadge endpoint={tile.badge} appId={tile.appId} />
                </span>
                <span class="max-w-full k2b-truncate-fade text-[11px] font-medium text-primary sm:text-xs dark:text-white">
                  {tile.label}
                  <Show when={badge()}>
                    <span class="sr-only">, {badge()}</span>
                  </Show>
                </span>
              </a>
            );
          }}
        </For>
      </div>
      <Show when={!tiles().length}>
        <p class="py-6 text-center text-dimmed">{messages().noAppsFound}</p>
      </Show>
      <Show when={props.surface === "sheet" && props.profile && props.beforeSelect}>
        <MobileProfileActions profile={props.profile!} beforeSelect={props.beforeSelect!} />
      </Show>
      <Show when={props.legalLinks.length > 0}>
        <div class="mt-7 flex flex-wrap justify-center text-[11px] text-dimmed dark:text-white/56">
          <For each={props.legalLinks.filter((link) => !(props.surface === "sheet" && props.profile && link.href === "/me"))}>
            {(link) => (
              <a
                onClick={follow}
                href={link.href}
                class="inline-flex items-center gap-1.5 rounded-md px-2 py-1 transition-colors hover:text-primary dark:hover:text-white"
              >
                <i class={link.icon ?? "ti ti-file-text"} />
                {link.label}
              </a>
            )}
          </For>
        </div>
      </Show>
    </Dynamic>
  );
};
