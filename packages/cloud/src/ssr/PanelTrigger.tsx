import { IconButton, Tooltip, useLocale } from "@k2b/ui";
import { isServer } from "solid-js/web";
import type { PanelRequest } from "../browser/panel";
import { platformMessages } from "./platform-messages";
import { useShellData } from "./shell-data";

export default function PanelTrigger(props: { variant: "rail" | "header"; open?: boolean }) {
  const locale = useLocale();
  const data = useShellData();
  const t = () => platformMessages.resolve([locale()]).t;
  const title = () => t().panelShortcut({ mod: data?.platform === "apple" ? "⌘" : "Ctrl+" });
  // The lazy controller may have changed state before this island mounts.
  const open = () =>
    isServer
      ? !!props.open
      : document
          .querySelector(".cloud-app-canvas")
          ?.getAttribute(window.matchMedia("(min-width: 768px)").matches ? "data-panel" : "data-panel-sheet") === "open";
  const toggle = () => window.dispatchEvent(new CustomEvent<PanelRequest>("cloud.panel.request", { detail: { action: "toggle" } }));
  if (props.variant === "rail")
    return (
      <Tooltip.Trigger
        type="button"
        class="rail-item"
        aria-label={t().openPanel}
        aria-controls="cloud-panel"
        aria-expanded={open()}
        data-cloud-panel-toggle=""
        content={title()}
        placement="right"
        delay={0}
        onClick={toggle}
      >
        <i class="ti ti-layout-sidebar-right text-xl" aria-hidden="true" />
      </Tooltip.Trigger>
    );
  return (
    <IconButton
      label={t().openPanel}
      title={title()}
      aria-controls="cloud-panel"
      aria-expanded={open()}
      data-cloud-panel-toggle=""
      onClick={toggle}
    >
      <i class="ti ti-layout-sidebar-right text-base" aria-hidden="true" />
    </IconButton>
  );
}
