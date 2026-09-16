import { toast } from "@k2b/ui";
import { resourceSearchMessages } from "./resource-search-messages";
import { type GlobalSearchOptions, requestGlobalSearch } from "./search-bridge";

export type { GlobalSearchOptions, SearchNavigationTarget, SearchScope } from "./search-bridge";
export { registerSearchNavigation } from "./search-bridge";

/** Open the Cloud layout's search, optionally within one removable context. */
export const openGlobalSearch = (options: GlobalSearchOptions = {}): void => {
  void requestGlobalSearch(options).catch(() => {
    toast.error(resourceSearchMessages.resolve([document.documentElement.lang || "en"]).t.searchFailed);
  });
};
