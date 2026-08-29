import { prompts } from "@k2b/ui";
import type { SearchItem } from "../api/search/schemas";
import type { CloudResourceRef } from "../contracts";
import CloudResourceSearch from "./CloudResourceSearch";
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
  return prompts.dialog<CloudResourcePickerItem>(
    (close) => (
      <div class="k2b-dialog__body h-[min(36rem,var(--ui-dialog-available-height))] min-h-0 p-0">
        <CloudResourceSearch
          initialAppId={options.initialAppId}
          excludeRefs={options.excludeRefs}
          requireReader={options.requireReader}
          placeholder={options.placeholder ?? t.searchPlaceholder}
          onSelect={close}
        />
      </div>
    ),
    {
      title: options.title ?? t.chooseResource,
      icon: "ti ti-cloud-search",
      size: "large",
      ariaLabel: options.title ?? t.chooseResource,
    },
  );
};
