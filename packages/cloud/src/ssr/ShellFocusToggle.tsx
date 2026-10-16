import { IconButton, Tooltip, useLocale } from "@k2b/ui";
import { platformMessages } from "./platform-messages";

/**
 * The two buttons of the shell's focus state. The app bar's button hides the
 * app bar and the app's navigation; the floating one shows them again. Both
 * are always rendered, and the canvas's `data-shell-focus` decides in CSS which
 * one shows, so the server's first frame is final. `ShellRuntime` handles
 * their clicks by `data-cloud-shell-focus-toggle`, so the floating button is
 * plain server markup, with its shortcut in the native title, and needs no
 * island of its own.
 */
export default function ShellFocusToggle(props: { variant: "rail" | "float" }) {
  const locale = useLocale();
  const t = () => platformMessages.resolve([locale()]).t;
  if (props.variant === "rail")
    return (
      <Tooltip.Trigger
        type="button"
        class="rail-item"
        data-cloud-shell-focus-toggle="hide"
        aria-label={t().hideSidebar}
        placement="right"
        delay={0}
        content={t().hideSidebarShortcut}
      >
        <i class="ti ti-layout-sidebar-left-collapse text-xl" aria-hidden="true" />
      </Tooltip.Trigger>
    );
  return (
    <div class="cloud-shell-show">
      <IconButton
        variant="secondary"
        size="lg"
        data-cloud-shell-focus-toggle="show"
        label={t().showSidebar}
        title={t().showSidebarShortcut}
      >
        <i class="ti ti-layout-sidebar-left-expand text-xl" aria-hidden="true" />
      </IconButton>
    </div>
  );
}
