import { AppLaunchpadPanel, type AppLaunchpadApp, type AppLaunchpadLegalLink, type AppLaunchpadContext } from "./AppLaunchpadPanel";
import { openCloudMobileMenu } from "./MobileNavigation";
export type { AppLaunchpadApp, AppLaunchpadLegalLink } from "./AppLaunchpadPanel";
import { dialogCore, IconButton, Tooltip, useLocale } from "@k2b/ui";
import { createEffect } from "solid-js";
import { platformMessages } from "./platform-messages";

declare global {
  interface Window {
    __cloudAppLaunchpad?: AppLaunchpadContext;
    cloud?: {
      openAppLaunchpad?: () => void;
    };
  }
}

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
      profile: parsed.profile?.name && (parsed.profile.theme === "dark" || parsed.profile.theme === "light") ? parsed.profile : undefined,
      legalLinks: Array.isArray(parsed.legalLinks) ? parsed.legalLinks : [],
    };
  } catch {
    return undefined;
  }
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

export function openAppLaunchpad(apps?: AppLaunchpadApp[], legalLinks?: AppLaunchpadLegalLink[], profile?: AppLaunchpadContext["profile"]) {
  if (typeof window === "undefined") return;
  const context = apps ? { apps, legalLinks: legalLinks ?? [], profile } : (window.__cloudAppLaunchpad ?? readEmbeddedContext());
  if (!context) return;
  window.__cloudAppLaunchpad = context;
  if (window.matchMedia("(max-width: 1023px)").matches) {
    void openCloudMobileMenu(context);
    return;
  }
  void dialogCore.open<void>((close) => <AppLaunchpadPanel apps={context.apps} legalLinks={context.legalLinks} close={close} />, {
    panelClassName: "k2b-dialog k2b-dialog--large is-bare",
    contentClassName: "k2b-dialog__viewport is-bare",
    initialFocus: (dialog) => dialog.querySelector<HTMLAnchorElement>("a[href]"),
  });
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
  const open = () => openAppLaunchpad(props.apps, props.legalLinks, props.profile);

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
    return <AppLaunchpadProvider apps={props.apps} legalLinks={props.legalLinks} profile={props.profile} />;
  }

  return <AppLaunchpadButton apps={props.apps} legalLinks={props.legalLinks} profile={props.profile} variant={props.variant} label={props.label} />;
}

export default AppLaunchpad;
