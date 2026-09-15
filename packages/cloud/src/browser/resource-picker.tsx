import { dialogCore } from "@k2b/ui";
import type { SearchItem } from "../api/search/schemas";
import type { CloudResourceRef } from "../contracts";
import CloudResourceSearch from "./CloudResourceSearch";
import { resourceSearchDialogOptions } from "./resource-search-dialog";
import { resourceSearchMessages } from "./resource-search-messages";

export type CloudResourcePickerItem = SearchItem;
export type CloudResourcePickerOptions = {
  title?: string;
  placeholder?: string;
  initialAppId?: string;
  excludeRefs?: readonly CloudResourceRef[];
  requireReader?: boolean;
};

export const openCloudResourcePicker = (options: CloudResourcePickerOptions = {}): Promise<CloudResourcePickerItem | undefined> => {
  const locale = typeof document === "undefined" ? "en" : document.documentElement.lang || "en";
  const t = resourceSearchMessages.resolve([locale]).t;
  return dialogCore.open<CloudResourcePickerItem>(
    (close) => (
      <CloudResourceSearch {...options} title={options.title ?? t.chooseResource} selectionMode onSelect={close} onClose={() => close()} />
    ),
    resourceSearchDialogOptions(options.title ?? t.chooseResource),
  );
};
