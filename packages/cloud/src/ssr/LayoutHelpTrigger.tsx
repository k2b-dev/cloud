import { IconButton, Tooltip, useLocale } from "@k2b/ui";
import { createSignal, onCleanup, onMount } from "solid-js";
import { isServer } from "solid-js/web";
import { closePanel, openPanel } from "../browser/panel";
import { importOnDemand } from "../browser/reload";
import { createBusyAction } from "./busy-action";
import { platformMessages } from "./platform-messages";

type LayoutHelpTriggerProps = {
  variant: "header" | "rail";
  class?: string;
  panel?: boolean;
  helpOpen?: boolean;
};

/** Opens end-user help from either the desktop rail or the compact header. */
export default function LayoutHelpTrigger(props: LayoutHelpTriggerProps) {
  const locale = useLocale();
  const t = () => platformMessages.resolve([locale()]).t;
  const action = createBusyAction();
  // The server knows the cookie; the browser also knows the mode: a phone starts with the sheet closed, whatever the
  // cookie says, and the lazy controller may have changed the state before this island mounts.
  const readOpen = () => {
    const canvas = document.querySelector(".cloud-app-canvas");
    const attribute = window.matchMedia("(min-width: 768px)").matches ? "data-panel" : "data-panel-sheet";
    return canvas?.getAttribute(attribute) === "open" && document.getElementById("cloud-panel")?.dataset.provider === "core";
  };
  const [helpOpen, setHelpOpen] = createSignal(isServer ? !!props.helpOpen : !!props.panel && readOpen());
  onMount(() => {
    const changed = (event: WindowEventMap["cloud.panel.state"]) => setHelpOpen(event.detail.open && event.detail.provider === "core");
    window.addEventListener("cloud.panel.state", changed);
    onCleanup(() => window.removeEventListener("cloud.panel.state", changed));
  });
  const openHelp = () => {
    if (helpOpen()) return closePanel();
    if (openPanel("core")) return;
    return action.run(
      () => importOnDemand(() => import("./LayoutHelp")),
      (help) => help.openLayoutHelpDialog(),
    );
  };

  if (props.variant === "rail")
    return (
      <Tooltip.Trigger
        type="button"
        class={`rail-item text-blue-500 hover:bg-blue-500/10 hover:text-blue-600 dark:text-blue-400 dark:hover:bg-blue-500/15 dark:hover:text-blue-300 ${props.class ?? ""}`}
        aria-controls={props.panel ? "cloud-panel" : undefined}
        aria-expanded={props.panel ? helpOpen() : undefined}
        onClick={openHelp}
        aria-busy={action.busy() ? "true" : undefined}
        aria-label={t().openHelp}
        placement="right"
        delay={0}
        content={t().helpShortcut}
      >
        <i class={`${action.busy() ? "ti ti-loader-2 animate-spin" : "ti ti-help-circle"} text-xl`} />
      </Tooltip.Trigger>
    );

  return (
    <IconButton
      class={props.class}
      aria-controls={props.panel ? "cloud-panel" : undefined}
      aria-expanded={props.panel ? helpOpen() : undefined}
      onClick={openHelp}
      aria-busy={action.busy() ? "true" : undefined}
      label={t().openHelp}
      title={t().helpShortcut}
    >
      <i class={`${action.busy() ? "ti ti-loader-2 animate-spin" : "ti ti-help-circle"} text-base`} />
    </IconButton>
  );
}
