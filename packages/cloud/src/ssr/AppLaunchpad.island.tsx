import { dialogCore, IconButton, ScrollArea, Tooltip, useLocale } from "@k2b/ui";
import { createEffect, For, Show } from "solid-js";
import { platformMessages } from "./platform-messages";
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

type AppLaunchpadContext = {
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

declare global {
  interface Window {
    __cloudAppLaunchpad?: AppLaunchpadContext;
    cloud?: {
      openAppLaunchpad?: () => void;
    };
  }
}

const paletteForId = (id: string) => {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash + id.charCodeAt(i)) % appIconPalette.length;
  return appIconPalette[hash] ?? appIconPalette[0];
};

const appIconStyle = (app: AppLaunchpadApp) => {
  const tone = /^#[0-9a-f]{6}$/i.test(app.accent ?? "") ? app.accent! : paletteForId(app.id).from;
  return `--app-icon-color:${tone}`;
};

const readEmbeddedContext = (): AppLaunchpadContext | undefined => {
  if (typeof document === "undefined") return undefined;
  const element = document.getElementById("cloud-app-launchpad-data");
  const text = element?.textContent;
  if (!text) return undefined;

  try {
    const parsed = JSON.parse(text) as Partial<AppLaunchpadContext>;
    if (!Array.isArray(parsed.apps)) return undefined;
    return {
      apps: parsed.apps,
      legalLinks: Array.isArray(parsed.legalLinks) ? parsed.legalLinks : [],
    };
  } catch {
    return undefined;
  }
};

const AppLaunchpadPanel = (props: AppLaunchpadContext & { close: () => void }) => {
  const locale = useLocale();
  const t = () => railMessages.resolve([locale()]).t;
  const rail = readRailContext();
  const shortcuts = () => (rail ? projectRailNavigation(rail.apps, rail.settings, locale()).shortcuts : []);
  return (
    <ScrollArea class="launchpad-panel mx-auto max-h-[min(86vh,var(--ui-dialog-available-height))] w-[var(--ui-dialog-available-width)] max-w-[var(--ui-dialog-available-width)] overscroll-contain p-4 text-primary sm:w-fit sm:p-6 md:p-7 dark:text-white">
      <Show when={rail}>
        <div class="mb-2 flex justify-end">
          <IconButton
            variant="ghost"
            size="sm"
            label={t().customize}
            tooltip={t().customize}
            tooltipDelay={0}
            onClick={() => {
              props.close();
              openRailEditor(locale());
            }}
          >
            <i class="ti ti-adjustments-horizontal" aria-hidden="true" />
          </IconButton>
        </div>
      </Show>
      <Show when={shortcuts().length > 0}>
        <section class="mb-5 flex flex-col gap-3" aria-label={t().shortcuts}>
          <h3 class="text-center text-sm font-medium">{t().shortcuts}</h3>
          <div class="flex flex-wrap justify-center gap-2">
            <For each={shortcuts()}>
              {(shortcut) => (
                <a
                  href={shortcut.href}
                  class="inline-flex items-center gap-2 rounded-lg border border-[var(--ui-border)] px-3 py-2 text-sm"
                >
                  <i class={shortcut.iconClass} aria-hidden="true" />
                  {shortcut.label}
                </a>
              )}
            </For>
          </div>
        </section>
      </Show>
      <div class="flex flex-wrap justify-center gap-x-4 gap-y-4 sm:gap-x-7 sm:gap-y-6">
        <For each={props.apps}>
          {(app) => (
            <a
              href={app.href}
              class="group flex w-[4.75rem] min-w-0 flex-col items-center gap-1.5 rounded-2xl p-1 text-center outline-none focus-visible:ring-2 focus-visible:ring-white/60 sm:w-[6.25rem] sm:gap-2 sm:p-2"
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
      <Show when={props.legalLinks.length > 0}>
        <div class="mt-7 flex flex-wrap justify-center text-[11px] text-dimmed dark:text-white/56">
          <For each={props.legalLinks}>
            {(link) => (
              <a
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
    </ScrollArea>
  );
};

export function setAppLaunchpadContext(apps: AppLaunchpadApp[], legalLinks: AppLaunchpadLegalLink[] = []) {
  if (typeof window === "undefined") return;
  window.__cloudAppLaunchpad = { apps, legalLinks };
  window.cloud ??= {};
  window.cloud.openAppLaunchpad = () => {
    openAppLaunchpad();
  };
}

export function openAppLaunchpad(apps?: AppLaunchpadApp[], legalLinks?: AppLaunchpadLegalLink[]) {
  if (typeof window === "undefined") return;
  const context = apps ? { apps, legalLinks: legalLinks ?? [] } : (window.__cloudAppLaunchpad ?? readEmbeddedContext());
  if (!context || context.apps.length === 0) return;
  window.__cloudAppLaunchpad = context;
  void dialogCore.open<void>((close) => <AppLaunchpadPanel apps={context.apps} legalLinks={context.legalLinks} close={close} />, {
    panelClassName: "k2b-dialog k2b-dialog--large is-bare",
    contentClassName: "k2b-dialog__viewport is-bare",
    initialFocus: (dialog) => dialog.querySelector<HTMLAnchorElement>("a[href]"),
  });
}

export function AppLaunchpadProvider(props: AppLaunchpadContext) {
  createEffect(() => {
    setAppLaunchpadContext(props.apps, props.legalLinks);
  });

  return <span class="hidden" data-cloud-app-launchpad-provider />;
}

export function AppLaunchpadButton(props: AppLaunchpadContext & { variant: "rail" | "header" | "menu"; label?: string }) {
  const locale = useLocale();
  const t = () => platformMessages.resolve([locale()]).t;
  const open = () => openAppLaunchpad(props.apps, props.legalLinks);

  if (props.variant === "rail") {
    return (
      <Tooltip.Trigger
        type="button"
        class="rail-item shrink-0"
        content={props.label ?? t().apps}
        placement="right"
        delay={0}
        aria-label={props.label ?? t().openApps}
        onClick={open}
      >
        <i class="ti ti-grid-dots text-base" aria-hidden="true" />
      </Tooltip.Trigger>
    );
  }

  if (props.variant === "header") {
    return (
      <IconButton label={props.label ?? t().openApps} onClick={open}>
        <i class="ti ti-grid-dots text-lg" />
      </IconButton>
    );
  }

  return (
    <button
      type="button"
      class="flex w-full items-center gap-3 px-4 py-2 text-sm transition-colors hover:bg-white/30 dark:hover:bg-white/10 text-zinc-700 dark:text-zinc-300"
      onClick={open}
    >
      <i class="ti ti-grid-dots" />
      <span>{props.label ?? t().apps}</span>
    </button>
  );
}

export function AppLaunchpad(props: AppLaunchpadContext & { variant?: "provider" | "rail" | "header" | "menu"; label?: string }) {
  if (!props.variant || props.variant === "provider") {
    return <AppLaunchpadProvider apps={props.apps} legalLinks={props.legalLinks} />;
  }

  return <AppLaunchpadButton apps={props.apps} legalLinks={props.legalLinks} variant={props.variant} label={props.label} />;
}

export default AppLaunchpad;
