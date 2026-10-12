import { IconButton, Tooltip, useLocale } from "@k2b/ui";
import { createEffect } from "solid-js";
import { importOnDemand } from "../browser/reload";
import type { AppLaunchpadApp, AppLaunchpadContext, AppLaunchpadLegalLink } from "./AppLaunchpadPanel";
import { createBusyAction } from "./busy-action";
import { platformMessages } from "./platform-messages";
import { readShellData } from "./shell-data";

export type { AppLaunchpadApp, AppLaunchpadLegalLink } from "./AppLaunchpadPanel";

declare global {
  interface Window {
    __cloudAppLaunchpad?: AppLaunchpadContext;
    cloud?: {
      openAppLaunchpad?: () => void;
    };
  }
}

const readEmbeddedContext = (): AppLaunchpadContext | undefined => {
  const data = readShellData();
  if (!data) return undefined;
  return {
    apps: data.apps,
    profile: data.profile
      ? { name: data.profile.name, theme: data.theme, ...(data.profile.appHref === "/me/app" ? { appHref: data.profile.appHref } : {}) }
      : undefined,
    legalLinks: data.legalLinks,
  };
};

export function setAppLaunchpadContext(
  apps: AppLaunchpadApp[],
  legalLinks: AppLaunchpadLegalLink[] = [],
  profile?: AppLaunchpadContext["profile"],
) {
  if (typeof window === "undefined") return;
  window.__cloudAppLaunchpad = { apps, legalLinks, profile };
  window.cloud ??= {};
  window.cloud.openAppLaunchpad = () => {
    openAppLaunchpad();
  };
}

/** Every caller of the public opener shares one load, so a double click opens one dialog. */
let launchpadPending: Promise<void> | undefined;

export function openAppLaunchpad(apps?: AppLaunchpadApp[], legalLinks?: AppLaunchpadLegalLink[], profile?: AppLaunchpadContext["profile"]) {
  if (typeof window === "undefined" || launchpadPending) return;
  const context = apps ? { apps, legalLinks: legalLinks ?? [], profile } : (window.__cloudAppLaunchpad ?? readEmbeddedContext());
  if (!context) return;
  window.__cloudAppLaunchpad = context;
  launchpadPending = importOnDemand(() => import("./launchpad-surface"))
    .then((loaded) => loaded?.openLaunchpadSurface(context))
    .finally(() => {
      launchpadPending = undefined;
    });
  return launchpadPending;
}

export function AppLaunchpadProvider(props: AppLaunchpadContext) {
  createEffect(() => {
    setAppLaunchpadContext(props.apps, props.legalLinks, props.profile);
  });

  return <span class="hidden" data-cloud-app-launchpad-provider />;
}

export function AppLaunchpadButton(props: AppLaunchpadContext & { variant: "rail" | "header" | "menu"; label?: string }) {
  const locale = useLocale();
  const t = () => platformMessages.resolve([locale()]).t;
  const action = createBusyAction();
  const open = () =>
    action.run(
      () => importOnDemand(() => import("./launchpad-surface")),
      (loaded) => {
        const context = { apps: props.apps, legalLinks: props.legalLinks, profile: props.profile };
        window.__cloudAppLaunchpad = context;
        loaded.openLaunchpadSurface(context);
      },
    );

  if (props.variant === "rail") {
    return (
      <Tooltip.Trigger
        type="button"
        class="rail-item shrink-0"
        data-cloud-launchpad
        content={props.label ?? t().apps}
        placement="right"
        delay={0}
        aria-label={props.label ?? t().openApps}
        onClick={open}
        aria-busy={action.busy() ? "true" : undefined}
      >
        <i class={`${action.busy() ? "ti ti-loader-2 animate-spin" : "ti ti-grid-dots"} text-base`} aria-hidden="true" />
      </Tooltip.Trigger>
    );
  }

  if (props.variant === "header") {
    return (
      <IconButton label={props.label ?? t().openApps} onClick={open} aria-busy={action.busy() ? "true" : undefined}>
        <i class={`${action.busy() ? "ti ti-loader-2 animate-spin" : "ti ti-grid-dots"} text-lg`} />
      </IconButton>
    );
  }

  return (
    <button
      type="button"
      class="flex w-full items-center gap-3 px-4 py-2 text-sm transition-colors hover:bg-white/30 dark:hover:bg-white/10 text-zinc-700 dark:text-zinc-300"
      onClick={open}
      aria-busy={action.busy() ? "true" : undefined}
    >
      <i class={action.busy() ? "ti ti-loader-2 animate-spin" : "ti ti-grid-dots"} />
      <span>{props.label ?? t().apps}</span>
    </button>
  );
}
