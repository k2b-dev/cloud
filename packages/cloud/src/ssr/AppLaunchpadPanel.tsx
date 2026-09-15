import type { CloudTheme } from "../shared/theme";
import { MobileProfileActions } from "./MobileProfileActions";
import { Dynamic } from "solid-js/web";
import { platformMessages } from "./platform-messages";
import { IconButton, ScrollArea, TextInput, useLocale } from "@k2b/ui";
import { createSignal, For, Show, type JSX } from "solid-js";
import { documentNavigate } from "@k2b/ssr/nav";
import { openRailEditor } from "./RailEditor";
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
};

export type AppLaunchpadLegalLink = {
  label: string;
  href: string;
  icon?: string;
};

export type AppLaunchpadContext = {
  profile?: { name: string; theme: CloudTheme };
  apps: AppLaunchpadApp[];
  legalLinks: AppLaunchpadLegalLink[];
};

type AppIconPaletteEntry = { from: string };

const appIconPalette: readonly [AppIconPaletteEntry, ...AppIconPaletteEntry[]] = [
  { from: "#2563eb" },
  { from: "#059669" },
  { from: "#7c3aed" },
  { from: "#d97706" },
  { from: "#e11d48" },
  { from: "#0891b2" },
  { from: "#52525b" },
];

const paletteForId = (id: string) => {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash + id.charCodeAt(i)) % appIconPalette.length;
  return appIconPalette[hash] ?? appIconPalette[0];
};

const appIconStyle = (app: AppLaunchpadApp) => {
  const tone = /^#[0-9a-f]{6}$/i.test(app.accent ?? "") ? app.accent! : paletteForId(app.id).from;
  return `--app-icon-color:${tone}`;
};

export const AppLaunchpadPanel = (
  props: AppLaunchpadContext & { close: () => void; beforeSelect?: () => Promise<boolean>; surface?: "panel" | "sheet" },
) => {
  const locale = useLocale();
  const t = () => railMessages.resolve([locale()]).t;
  const rail = readRailContext();
  const [query, setQuery] = createSignal("");
  const messages = () => platformMessages.resolve([locale()]).t;
  const matches = (label: string, description = "") =>
    `${label} ${description}`.toLocaleLowerCase(locale()).includes(query().trim().toLocaleLowerCase(locale()));
  const apps = () => props.apps.filter((app) => matches(app.label, app.description));
  const shortcuts = () =>
    (rail ? projectRailNavigation(rail.apps, rail.settings, locale()).shortcuts : []).filter((shortcut) => matches(shortcut.label));
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
              onClick={async () => {
                if (props.beforeSelect) {
                  if (!(await props.beforeSelect())) return;
                } else props.close();
                openRailEditor(locale());
              }}
            >
              <i class="ti ti-adjustments-horizontal" aria-hidden="true" />
            </IconButton>
          </div>
        </Show>
      </div>
      <Show when={shortcuts().length > 0}>
        <section class="mb-5" aria-label={t().shortcuts}>
          <div class="flex flex-wrap justify-center gap-3">
            <For each={shortcuts()}>
              {(shortcut) => (
                <a
                  onClick={follow}
                  href={shortcut.href}
                  class="group flex w-16 min-w-0 flex-col items-center gap-1 rounded-lg p-1 text-center focus-ui"
                >
                  <span class="grid h-9 w-9 place-items-center rounded-xl bg-[var(--ui-hover)] text-lg transition-colors group-hover:bg-[var(--ui-active)]">
                    <i class={shortcut.iconClass} aria-hidden="true" />
                  </span>
                  <span class="max-w-full truncate text-[11px] font-medium text-primary dark:text-white">{shortcut.label}</span>
                </a>
              )}
            </For>
          </div>
        </section>
      </Show>
      <div class="launchpad-apps-grid flex flex-wrap justify-center gap-x-4 gap-y-4 sm:gap-x-7 sm:gap-y-6">
        <For each={apps()}>
          {(app) => (
            <a
              onClick={follow}
              href={app.href}
              class="launchpad-app group flex w-[4.75rem] min-w-0 flex-col items-center gap-1.5 rounded-2xl p-1 text-center focus-ui sm:w-[6.25rem] sm:gap-2 sm:p-2"
            >
              <span
                class="app-icon grid h-12 w-12 place-items-center rounded-[0.95rem] text-[1.25rem] sm:h-16 sm:w-16 sm:rounded-[1.25rem] sm:text-[1.7rem]"
                style={appIconStyle(app)}
              >
                <i class={app.iconClass} />
              </span>
              <span class="max-w-full truncate text-[11px] font-medium text-primary sm:text-xs dark:text-white">{app.label}</span>
            </a>
          )}
        </For>
      </div>
      <Show when={!apps().length && !shortcuts().length}>
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
