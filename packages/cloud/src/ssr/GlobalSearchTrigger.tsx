import { IconButton, Kbd, useLocale } from "@k2b/ui";
import { importOnDemand } from "../browser/reload";
import { openGlobalSearch } from "../browser/search";
import { createBusyAction } from "./busy-action";
import { platformMessages } from "./platform-messages";
import { RailItemHint } from "./RailItemHint";
import { useShellData } from "./shell-data";

type GlobalSearchTriggerProps = {
  variant: "header" | "rail";
  class?: string;
};

/** Opens the spotlight-style global search dialog from nav/header trigger points. */
export default function GlobalSearchTrigger(props: GlobalSearchTriggerProps) {
  const locale = useLocale();
  const t = () => platformMessages.resolve([locale()]).t;
  const data = useShellData();

  const action = createBusyAction();
  const open = () =>
    action.run(
      () => importOnDemand(() => import("./GlobalSearchDialog")),
      () => openGlobalSearch(),
    );

  if (props.variant === "rail") {
    let target: HTMLButtonElement | undefined;
    return (
      <>
        <button
          ref={target}
          type="button"
          class={`rail-item text-blue-500 hover:bg-blue-500/10 hover:text-blue-600 dark:text-blue-400 dark:hover:bg-blue-500/15 dark:hover:text-blue-300 ${props.class ?? ""}`}
          onClick={open}
          aria-busy={action.busy() ? "true" : undefined}
          aria-label={t().openGlobalSearch}
        >
          <i class={`${action.busy() ? "ti ti-loader-2 animate-spin" : "ti ti-search"} text-xl`} />
          <span class="rail-item-label">{t().railSearch}</span>
          <Kbd class="rail-item-keys" keys="mod+k" platform={data?.platform} />
        </button>
        <RailItemHint target={() => target} content={t().searchShortcut} />
      </>
    );
  }

  return (
    <IconButton
      class={props.class}
      onClick={open}
      aria-busy={action.busy() ? "true" : undefined}
      label={t().openGlobalSearch}
      title={t().searchShortcut}
    >
      <i class={`${action.busy() ? "ti ti-loader-2 animate-spin" : "ti ti-search"} text-base`} />
    </IconButton>
  );
}
