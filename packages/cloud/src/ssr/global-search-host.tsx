import { dialogCore, toast } from "@k2b/ui";
import { createSignal } from "solid-js";
import type { NavigationSearchItem } from "../browser/navigation-search";
import { importOnDemand } from "../browser/reload";
import { resourceSearchDialogOptions } from "../browser/resource-search-dialog";
import { resourceSearchMessages } from "../browser/resource-search-messages";
import type { GlobalSearchOptions } from "../browser/search-bridge";

/**
 * Owned by the layout island; neither dialog state nor callbacks cross SSR props. The dialog with search, commands
 * and their schemas loads on first open, so no page pays for it before someone searches.
 */
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
      void importOnDemand(() => import("./GlobalSearchDialog"))
        .then((loaded) => {
          if (!loaded || current.signal.aborted) return;
          const GlobalSearchDialog = loaded.default;
          return dialogCore.open<void>(
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
          );
        })
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
