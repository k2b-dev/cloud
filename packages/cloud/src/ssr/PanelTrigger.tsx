import { useLocale } from "@k2b/ui";
import { createSignal, onCleanup, onMount } from "solid-js";
import { isServer } from "solid-js/web";
import type { PanelRequest } from "../browser/panel";
import { platformMessages } from "./platform-messages";
import { RailItemHint } from "./RailItemHint";
import { useShellData } from "./shell-data";

/**
 * The rail's button that opens and closes the panel. Its arrow and its name say what a click does; it takes the blue
 * of search and help, and an open panel keeps its fill. Phones have no such button: help opens the panel there, and
 * its tabs lead to the other panels.
 */
export default function PanelTrigger(props: { open?: boolean }) {
  const locale = useLocale();
  const data = useShellData();
  const t = () => platformMessages.resolve([locale()]).t;
  const title = () => t().panelShortcut({ mod: data?.platform === "apple" ? "⌘" : "Ctrl+" });
  // The lazy controller may have changed state before this island mounts.
  const readOpen = () =>
    document
      .querySelector(".cloud-app-canvas")
      ?.getAttribute(window.matchMedia("(min-width: 768px)").matches ? "data-panel" : "data-panel-sheet") === "open";
  const [open, setOpen] = createSignal(isServer ? !!props.open : readOpen());
  onMount(() => {
    const changed = (event: WindowEventMap["cloud.panel.state"]) => setOpen(event.detail.open);
    window.addEventListener("cloud.panel.state", changed);
    onCleanup(() => window.removeEventListener("cloud.panel.state", changed));
  });
  const label = () => (open() ? t().closePanel : t().openPanel);
  const icon = () => (open() ? "ti ti-layout-sidebar-right-collapse" : "ti ti-layout-sidebar-right-expand");
  const toggle = () => window.dispatchEvent(new CustomEvent<PanelRequest>("cloud.panel.request", { detail: { action: "toggle" } }));
  let target: HTMLButtonElement | undefined;
  return (
    <>
      <button
        ref={target}
        type="button"
        class="rail-item rail-item-panel text-blue-500 hover:bg-blue-500/10 hover:text-blue-600 dark:text-blue-400 dark:hover:bg-blue-500/15 dark:hover:text-blue-300"
        aria-label={label()}
        aria-controls="cloud-panel"
        aria-expanded={open()}
        data-cloud-panel-toggle=""
        onClick={toggle}
      >
        <i class={`${icon()} text-xl`} aria-hidden="true" />
        <span class="rail-item-label">{t().railPanel}</span>
      </button>
      <RailItemHint target={() => target} content={title()} />
    </>
  );
}
