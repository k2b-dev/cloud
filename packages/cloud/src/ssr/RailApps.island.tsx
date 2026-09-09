import { ScrollArea, Tooltip, useLocale } from "@k2b/ui";
import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import type { RailPreferences } from "../contracts/rail-preferences";
import { appAccentStyle } from "./app-appearance";
import { RAIL_PREFERENCES_EVENT, readRailContext } from "./rail-context";
import { projectRailNavigation, type RailApp, type RailLink, railLinkActive } from "./rail-navigation";

function RailIcon(props: { link: RailLink; currentUrl: string }) {
  let target: HTMLAnchorElement | undefined;
  const active = () => railLinkActive(props.link, props.currentUrl);
  return (
    <>
      <a
        ref={target}
        href={props.link.href}
        class={`rail-item shrink-0 ${active() ? "rail-item-active" : ""}`}
        aria-label={props.link.label}
        aria-current={active() ? "page" : undefined}
        style={appAccentStyle(props.link.accent)}
      >
        <i class={`${props.link.iconClass} text-base`} aria-hidden="true" />
        <span class="sr-only">{props.link.label}</span>
      </a>
      <Tooltip target={() => target} content={props.link.label} placement="right" delay={0} />
    </>
  );
}

export default function RailApps(props: { apps: RailApp[]; settings: RailPreferences; currentUrl: string }) {
  const locale = useLocale();
  const [settings, setSettings] = createSignal(props.settings);
  const [currentUrl, setCurrentUrl] = createSignal(props.currentUrl);
  const navigation = createMemo(() => projectRailNavigation(props.apps, settings(), locale()));
  onMount(() => {
    const sync = () => setSettings(readRailContext()?.settings ?? props.settings);
    const syncLocation = () => setCurrentUrl(window.location.href);
    sync();
    syncLocation();
    window.addEventListener(RAIL_PREFERENCES_EVENT, sync);
    window.addEventListener("popstate", syncLocation);
    window.addEventListener("hashchange", syncLocation);
    onCleanup(() => {
      window.removeEventListener(RAIL_PREFERENCES_EVENT, sync);
      window.removeEventListener("popstate", syncLocation);
      window.removeEventListener("hashchange", syncLocation);
    });
  });
  return (
    <ScrollArea
      class="flex w-full flex-col items-center gap-1"
      style={{ flex: "0 1 auto", "scrollbar-width": "none", "scrollbar-gutter": "auto", "overflow-x": "hidden" }}
      data-cloud-rail-apps
    >
      <For each={navigation().shortcuts}>{(link) => <RailIcon link={link} currentUrl={currentUrl()} />}</For>
      <Show when={navigation().shortcuts.length > 0 && navigation().apps.length > 0}>
        <div role="separator" class="my-1 h-px w-5 shrink-0" style={{ background: "var(--ui-divider)" }} />
      </Show>
      <For each={navigation().apps}>{(link) => <RailIcon link={link} currentUrl={currentUrl()} />}</For>
    </ScrollArea>
  );
}
