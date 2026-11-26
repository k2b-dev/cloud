import { IconButton, Kbd, useLocale } from "@k2b/ui";
import { focusPageSearch } from "@k2b/ui/v2/host";
import { onMount } from "solid-js";
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

  // On the phone the header's search stands for the search of a v2 page's head, where there is one (one search place).
  return (
    <IconButton
      // on a v2 page the shell hosts the page's search: the button carries its mark there (v2.css), set in the browser so
      // the server's HTML of every other page stays as it is
      ref={(button: HTMLButtonElement) => {
        onMount(() => button.toggleAttribute("data-k2-host-search-button", button.closest("[data-k2-host-search]") !== null));
      }}
      class={props.class}
      onClick={() => {
        if (!focusPageSearch()) open();
      }}
      aria-busy={action.busy() ? "true" : undefined}
      label={t().openGlobalSearch}
      title={t().searchShortcut}
    >
      <i class={`${action.busy() ? "ti ti-loader-2 animate-spin" : "ti ti-search"} text-base`} />
    </IconButton>
  );
}
