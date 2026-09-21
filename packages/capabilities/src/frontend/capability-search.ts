import { type GlobalSearchOptions, openGlobalSearch } from "@k2b/cloud/browser/search";
export const capabilitySearchOptions = (): GlobalSearchOptions => ({
  query: "",
  scope: { appId: "capabilities", label: "Capabilities", icon: "ti ti-api-app" },
});
export const openCapabilitySearch = () => openGlobalSearch(capabilitySearchOptions());
