import { type DialogRender, dialogCore } from "@k2b/ui";
import { For, onCleanup, onMount } from "solid-js";
import type { SearchItem } from "../api/search/schemas";
import CloudResourceSearch from "../browser/CloudResourceSearch";
import type { NavigationSearchItem } from "../browser/navigation-search";
import { resourceSearchDialogOptions } from "../browser/resource-search-dialog";
import { resourceSearchMessages } from "../browser/resource-search-messages";
import { attachSpotlightPosition } from "../browser/spotlight-position";

type GlobalSearchDialogProps = {
  close: () => void;
  context?: Parameters<DialogRender<void>>[1];
  searchLinks?: NavigationSearchItem[];
};

export default function GlobalSearchDialog(props: GlobalSearchDialogProps) {
  let host!: HTMLDivElement;
  onMount(() => {
    if (props.context) onCleanup(attachSpotlightPosition(host, props.context));
  });
  const openInNewTab = (item: SearchItem) => {
    window.open(item.href, "_blank", "noopener,noreferrer");
  };
  const openItem = (item: SearchItem) => {
    props.close();
    window.location.href = item.href;
  };
  return (
    <div ref={host} class="cloud-global-search">
      <CloudResourceSearch navigationItems={props.searchLinks} onClose={props.close} onSelect={openItem} onOpenInNewTab={openInNewTab} />
      <For each={["top", "right", "bottom", "left"]}>{(edge) => <div aria-hidden="true" data-search-grip={edge} />}</For>
    </div>
  );
}

export const openGlobalSearchDialog = (searchLinks: NavigationSearchItem[] = []) => {
  if (dialogCore.isOpen()) {
    document.querySelector<HTMLInputElement>(".cloud-search-dialog[open] .cloud-global-search input[role=combobox]")?.focus();
    return;
  }
  const locale = typeof document === "undefined" ? "en" : document.documentElement.lang || "en";
  void dialogCore.open<void>(
    (close, context) => <GlobalSearchDialog searchLinks={searchLinks} close={close} context={context} />,
    resourceSearchDialogOptions(resourceSearchMessages.resolve([locale]).t.searchCloudResources),
  );
};
