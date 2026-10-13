import { IconButton, Tooltip, useLocale } from "@k2b/ui";
import { importOnDemand } from "../browser/reload";
import { createBusyAction } from "./busy-action";
import { platformMessages } from "./platform-messages";

type LayoutHelpTriggerProps = {
  variant: "header" | "rail";
  class?: string;
};

/** Opens end-user help from either the desktop rail or the compact header. */
export default function LayoutHelpTrigger(props: LayoutHelpTriggerProps) {
  const locale = useLocale();
  const t = () => platformMessages.resolve([locale()]).t;
  const action = createBusyAction();
  const openHelp = () =>
    action.run(
      () => importOnDemand(() => import("./LayoutHelp")),
      (help) => help.openLayoutHelpDialog(),
    );

  if (props.variant === "rail")
    return (
      <Tooltip.Trigger
        type="button"
        class={`rail-item text-blue-500 hover:bg-blue-500/10 hover:text-blue-600 dark:text-blue-400 dark:hover:bg-blue-500/15 dark:hover:text-blue-300 ${props.class ?? ""}`}
        onClick={openHelp}
        aria-busy={action.busy() ? "true" : undefined}
        aria-label={t().openHelp}
        placement="right"
        delay={0}
        content={t().helpShortcut}
      >
        <i class={`${action.busy() ? "ti ti-loader-2 animate-spin" : "ti ti-help-circle"} text-base`} />
      </Tooltip.Trigger>
    );

  return (
    <IconButton
      class={props.class}
      onClick={openHelp}
      aria-busy={action.busy() ? "true" : undefined}
      label={t().openHelp}
      title={t().helpShortcut}
    >
      <i class={`${action.busy() ? "ti ti-loader-2 animate-spin" : "ti ti-help-circle"} text-base`} />
    </IconButton>
  );
}
