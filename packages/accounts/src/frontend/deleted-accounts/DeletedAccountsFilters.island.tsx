import { navigateTo } from "@k2b/ssr/nav";
import { FilterChip, type FilterChipSection } from "@k2b/ui";
import { useAccountsMessages } from "../messages";

type DeletedAccountsFiltersProps = {
  search: string;
  reason: string;
};

const buildUrl = (params: { search?: string; reason?: string; page?: number }) => {
  const query = new URLSearchParams();
  if (params.search?.trim()) query.set("search", params.search.trim());
  if (params.reason?.trim()) query.set("reason", params.reason.trim());
  if (params.page && params.page > 1) query.set("page", String(params.page));
  const search = query.toString();
  return search ? `/app/accounts/deleted-accounts?${search}` : "/app/accounts/deleted-accounts";
};

export default function DeletedAccountsFilters(props: DeletedAccountsFiltersProps) {
  const messages = useAccountsMessages();
  const options = (): FilterChipSection[] => [
    {
      options: [
        { value: "", label: messages().all, icon: "ti ti-list" },
        { value: "ipa_expired_demoted", label: messages().reasonIpaExpired, icon: "ti ti-user-down" },
        { value: "ipa_expired_deleted", label: messages().reasonIpaExpiredDelete, icon: "ti ti-user-x" },
        { value: "sync_out_of_scope_demoted", label: messages().reasonSyncOutOfScope, icon: "ti ti-user-off" },
        { value: "sync_out_of_scope_deleted", label: messages().reasonSyncDelete, icon: "ti ti-user-minus" },
        { value: "guest_expired_deleted", label: messages().reasonGuestExpired, icon: "ti ti-user-x" },
        { value: "local_user_expired_deleted", label: messages().reasonLocalExpired, icon: "ti ti-user-minus" },
        { value: "manual_demote", label: messages().reasonManualDemote, icon: "ti ti-user-down" },
        { value: "manual_delete", label: messages().reasonManualDelete, icon: "ti ti-trash" },
      ],
    },
  ];
  const navigate = (reason: string) => {
    navigateTo(buildUrl({ search: props.search, reason, page: 1 }));
  };

  return (
    <FilterChip
      label={messages().reason}
      icon="ti ti-filter"
      options={options()}
      value={props.reason ? [props.reason] : []}
      onValueChange={(value) => navigate(value[0] ?? "")}
      isActive={props.reason.length > 0}
      defaultValue={[]}
    />
  );
}
