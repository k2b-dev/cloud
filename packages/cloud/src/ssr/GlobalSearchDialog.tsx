import { type DialogRender, dialogCore, toast, useLocale } from "@k2b/ui";
import { createEffect, createSignal, For, onCleanup, onMount } from "solid-js";
import type { SearchItem } from "../api/search/schemas";
import CloudResourceSearch from "../browser/CloudResourceSearch";
import type { NavigationSearchItem } from "../browser/navigation-search";
import { resourceSearchDialogOptions } from "../browser/resource-search-dialog";
import { resourceSearchMessages } from "../browser/resource-search-messages";
import { type GlobalSearchOptions, requestSearchNavigation } from "../browser/search-bridge";
import { attachSpotlightPosition } from "../browser/spotlight-position";

type GlobalSearchDialogProps = {
  request?: GlobalSearchOptions;
  close: () => void;
  context?: Parameters<DialogRender<void>>[1];
  searchLinks?: NavigationSearchItem[];
  searchResources?: boolean;
};

export default function GlobalSearchDialog(props: GlobalSearchDialogProps) {
  const locale = useLocale();
  const messages = () => resourceSearchMessages.resolve([locale()]).t;
  let host!: HTMLDivElement;
  onMount(() => {
    if (props.context) onCleanup(attachSpotlightPosition(host, props.context, messages));
  });
  const openInNewTab = (item: SearchItem) => {
    window.open(item.href, "_blank", "noopener,noreferrer");
  };
  const [navigating, setNavigating] = createSignal(false);
  const [navigationError, setNavigationError] = createSignal(false);
  createEffect(() => {
    props.request;
    setNavigationError(false);
  });
  let active = true;
  onCleanup(() => {
    active = false;
  });
  const openItem = async (item: SearchItem) => {
    if (navigating()) return;
    setNavigating(true);
    setNavigationError(false);
    try {
      const handled = await requestSearchNavigation({
        href: item.href,
        ...(item.ref.type === "cloud.navigation" ? {} : { ref: item.ref }),
      });
      if (!active) return;
      props.close();
      if (!handled) window.location.assign(item.href);
    } catch {
      if (active) setNavigationError(true);
    } finally {
      if (active) setNavigating(false);
    }
  };
  return (
    <div ref={host} class="cloud-global-search">
      <CloudResourceSearch
        request={props.request}
        disabled={navigating()}
        navigationError={navigationError() ? messages().navigationFailed : undefined}
        navigationItems={props.searchLinks}
        searchResources={props.searchResources}
        onClose={props.close}
        onSelect={(item) => void openItem(item)}
        onOpenInNewTab={openInNewTab}
      />
      <For each={["top", "right", "bottom", "left"]}>{(edge) => <div aria-hidden="true" data-search-grip={edge} />}</For>
    </div>
  );
}

/** Owned by the layout island; neither dialog state nor callbacks cross SSR props. */
export const createGlobalSearchHost = (searchLinks: () => NavigationSearchItem[], searchResources = true) => {
  const [request, setRequest] = createSignal<GlobalSearchOptions>({});
  let controller: AbortController | undefined;
  return {
    open: (options: GlobalSearchOptions) => {
      setRequest({ ...options });
      if (controller) {
        document.querySelector<HTMLInputElement>(".cloud-global-search input[role=combobox]")?.focus();
        return;
      }
      const current = new AbortController();
      controller = current;
      const locale = document.documentElement.lang || "en";
      void dialogCore
        .open<void>(
          (close, context) => (
            <GlobalSearchDialog
              request={request()}
              searchLinks={searchLinks()}
              searchResources={searchResources}
              close={close}
              context={context}
            />
          ),
          { ...resourceSearchDialogOptions(resourceSearchMessages.resolve([locale]).t.searchCloudResources), signal: current.signal },
        )
        .catch(() => {
          toast.error(resourceSearchMessages.resolve([locale]).t.searchFailed);
        })
        .finally(() => {
          if (controller === current) controller = undefined;
        });
    },
    dispose: () => {
      controller?.abort();
      controller = undefined;
    },
  };
};
