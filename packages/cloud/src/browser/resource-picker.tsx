import { dialogCore } from "@k2b/ui";
import type { SearchItem } from "../api/search/schemas";
import type { CloudResourceRef } from "../contracts";
import CloudResourceSearch from "./CloudResourceSearch";
import { resourceSearchDialogOptions } from "./resource-search-dialog";
import { resourceSearchMessages } from "./resource-search-messages";
import type { SearchScope } from "./search-bridge";

export type CloudResourcePickerItem = SearchItem;
/** Narrows the server search to an app/tag or resource context; shown as a removable chip. */
export type CloudResourcePickerScope = SearchScope;
export type CloudResourcePickerOptions = {
  title?: string;
  placeholder?: string;
  initialAppId?: string;
  scope?: CloudResourcePickerScope;
  query?: string;
  excludeRefs?: readonly CloudResourceRef[];
  requireReader?: boolean;
  resourceType?: string;
};

export const openCloudResourcePicker = (options: CloudResourcePickerOptions = {}): Promise<CloudResourcePickerItem | undefined> => {
  const locale = typeof document === "undefined" ? "en" : document.documentElement.lang || "en";
  const t = resourceSearchMessages.resolve([locale]).t;
  return dialogCore.open<CloudResourcePickerItem>(
    (close) => (
      <CloudResourceSearch
        {...options}
        request={options.scope !== undefined || options.query !== undefined ? { scope: options.scope, query: options.query } : undefined}
        title={options.title ?? t.chooseResource}
        selectionMode
        onSelect={close}
        onClose={() => close()}
      />
    ),
    // A phone shows the picker as a full-screen sheet; global search keeps its floating card.
    {
      ...resourceSearchDialogOptions(options.title ?? t.chooseResource),
      panelClassName: "cloud-search-dialog cloud-search-dialog--picker",
    },
  );
};
