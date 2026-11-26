import { IconButton, Kbd, useLocale } from "@k2b/ui";
import { onCleanup, onMount } from "solid-js";
import { openPageSearch, returnPageSearchFocus } from "../browser/page-search";
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

  // on a v2 page, Escape in the head's search brings the focus back to this button; the app menu (the phone's sheet)
  // opens the global search through this button's deed
  let button: HTMLButtonElement | undefined;
  onMount(() => {
    if (props.page) onCleanup(returnPageSearchFocus(() => button));
    window.cloud ??= {};
    window.cloud.openGlobalSearch = open;
    onCleanup(() => {
      if (window.cloud?.openGlobalSearch === open) delete window.cloud.openGlobalSearch;
    });
  });
  return (
    <IconButton
      ref={button}
      class={props.class}
      onClick={() => {
        if (props.page && openPageSearch()) return;
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
