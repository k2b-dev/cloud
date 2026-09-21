import { type GlobalSearchOptions, openGlobalSearch } from "@k2b/cloud/browser/search";
import { useLocale } from "@k2b/ui";
import { accountsSearchMessages } from "../search-messages";
export const accountsSearchOptions = (locale: string): GlobalSearchOptions => ({
  query: "",
  scope: { appId: "accounts", label: accountsSearchMessages.resolve([locale]).t.title, icon: "ti ti-users-group" },
});
export function createAccountsSearch() {
  const locale = useLocale();
  return () => openGlobalSearch(accountsSearchOptions(locale()));
}
