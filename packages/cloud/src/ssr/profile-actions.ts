import { type DropdownItem, toast, useLocale } from "@k2b/ui";
import { createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { type IdleState, SHARED_WORKSTATION_EVENT, type SharedWorkstationEventDetail } from "../browser/idle-sign-out";
import { importOnDemand } from "../browser/reload";
import type { CloudThemePreference } from "../shared/theme";
import { createPreferenceController } from "./preference-controller";
import { sharedWorkstationMessages } from "./shared-workstation-messages";
import { useShellData } from "./shell-data";

const readBrowserState = (body: unknown): { sharedWorkstation: boolean; idle: IdleState | null } | null => {
  if (!body || typeof body !== "object" || !("sharedWorkstation" in body) || typeof body.sharedWorkstation !== "boolean") return null;
  const idle = "idle" in body ? body.idle : null;
  if (idle === null) return { sharedWorkstation: body.sharedWorkstation, idle: null };
  if (
    !idle ||
    typeof idle !== "object" ||
    !("remainingSeconds" in idle) ||
    !("timeoutSeconds" in idle) ||
    typeof idle.remainingSeconds !== "number" ||
    typeof idle.timeoutSeconds !== "number"
  )
    return null;
  return {
    sharedWorkstation: body.sharedWorkstation,
    idle: { remainingSeconds: idle.remainingSeconds, timeoutSeconds: idle.timeoutSeconds },
  };
};

/** The profile menu's switch: marks this browser, not the person, as a shared workstation. */
function createSharedWorkstationSwitch(userId: string | undefined, locale: () => string) {
  const [shared, setShared] = createSignal(useShellData()?.profile?.sharedWorkstation === true);
  const [pending, setPending] = createSignal(false);
  const messages = () => sharedWorkstationMessages.resolve([locale()]).t;
  onMount(() => {
    // The hover panel, the touch menu and the phone menu each hold a switch; one change shows in all of them.
    const sync = (event: Event) => {
      const detail = (event as CustomEvent<SharedWorkstationEventDetail>).detail;
      if (detail?.userId === userId) setShared(detail.idle !== null);
    };
    window.addEventListener(SHARED_WORKSTATION_EVENT, sync);
    onCleanup(() => window.removeEventListener(SHARED_WORKSTATION_EVENT, sync));
  });
  const toggle = async () => {
    if (pending() || !userId) return;
    setPending(true);
    const next = !shared();
    try {
      const response = await fetch("/api/me/browser/shared-workstation", {
        method: "PUT",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ shared: next }),
      });
      const state = response.ok ? readBrowserState(await response.json().catch(() => null)) : null;
      if (!state) throw new Error("Shared workstation change failed");
      window.dispatchEvent(
        new CustomEvent<SharedWorkstationEventDetail>(SHARED_WORKSTATION_EVENT, {
          detail: { userId, idle: state.sharedWorkstation ? state.idle : null },
        }),
      );
      toast.success(
        state.sharedWorkstation && state.idle
          ? messages().marked({ minutes: Math.round(state.idle.timeoutSeconds / 60) })
          : messages().unmarked,
      );
    } catch {
      toast.error(messages().failed);
    } finally {
      setPending(false);
    }
  };
  return { shared, pending, toggle, messages };
}

/** `appHref` is set while the installation offers the mobile app; the item then leads to `/me/app`. */
export function createProfileActions(initialTheme: CloudThemePreference, appHref?: string, userId?: string) {
  const locale = useLocale();
  const preferences = createPreferenceController(initialTheme, locale);
  const sharedWorkstation = createSharedWorkstationSwitch(userId, locale);
  const [signingOut, setSigningOut] = createSignal(false);
  const signOut = async () => {
    if (signingOut()) return;
    setSigningOut(true);
    // The API client and the push client load with the first sign-out, not with every page.
    const loaded = await importOnDemand(() => import("../browser/session"));
    if (!loaded) {
      setSigningOut(false);
      return;
    }
    try {
      await loaded.signOutBrowserSession(userId, preferences.messages().signOutFailed);
      window.location.href = "/auth/login";
    } catch {
      toast.error(preferences.messages().signOutFailed);
      setSigningOut(false);
    }
  };

  // What belongs to this browser, not to the person, stands apart at the end: the shared workstation mark and
  // sign-out, which ends the session, in the danger tone.
  const items = createMemo<DropdownItem[]>(() => [
    {
      items: [
        preferences.appearanceItem,
        preferences.languageItem(),
        {
          href: "/me",
          icon: "ti ti-user-circle",
          label: preferences.messages().profileSettings,
        },
        ...(appHref ? [{ href: appHref, icon: "ti ti-device-mobile", label: preferences.messages().app }] : []),
      ],
    },
    {
      ...(userId ? { sectionLabel: sharedWorkstation.messages().browserSection } : {}),
      items: [
        ...(userId
          ? [
              {
                choice: "checkbox" as const,
                checked: sharedWorkstation.shared,
                label: sharedWorkstation.messages().label,
                description: sharedWorkstation.messages().description,
                disabled: sharedWorkstation.pending(),
                closeOnSelect: false,
                action: () => void sharedWorkstation.toggle(),
              },
            ]
          : []),
        {
          action: signOut,
          icon: "ti ti-logout",
          label: preferences.messages().signOut,
          variant: "danger",
          disabled: signingOut(),
        },
      ],
    },
  ]);

  return { preferences, items, signOut, signingOut, sharedWorkstation };
}
