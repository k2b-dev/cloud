import { IconButton, Kbd, useLocale } from "@k2b/ui";
import { openPageSearch } from "../browser/page-search";
import { importOnDemand } from "../browser/reload";
import { openGlobalSearch } from "../browser/search";
import { createBusyAction } from "./busy-action";
import { platformMessages } from "./platform-messages";
import { RailItemHint } from "./RailItemHint";
import { useShellData } from "./shell-data";

type GlobalSearchTriggerProps = {
  variant: "header" | "rail";
  /** A v2 page: the phone bar's button opens the search of the page's head when it shows one, else the global search. */
  page?: boolean;
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
          class={`rail-item ${props.class ?? ""}`}
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
      onClick={(event) => {
        if (props.page && openPageSearch(event.currentTarget)) return;
        open();
      }}
      aria-busy={action.busy() ? "true" : undefined}
      label={props.page ? t().search : t().openGlobalSearch}
      title={props.page ? undefined : t().searchShortcut}
    >
      <i class={`${action.busy() ? "ti ti-loader-2 animate-spin" : "ti ti-search"} text-base`} />
    </IconButton>
  );
}
