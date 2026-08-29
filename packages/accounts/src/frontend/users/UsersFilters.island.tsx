import { navigateTo } from "@k2b/ssr/nav";
import { FilterChip, type FilterChipSection } from "@k2b/ui";
import { buildUsersUrl, type UsersListState } from "../lib/url-state";
import { useAccountsMessages } from "../messages";

type UsersFiltersProps = {
  state: UsersListState;
};

export default function UsersFilters(props: UsersFiltersProps) {
  const messages = useAccountsMessages();
  const providerOptions = (): FilterChipSection[] => [
    {
      options: [
        { value: "ipa", label: "FreeIPA", icon: "ti ti-building-fortress" },
        { value: "local", label: messages().local, icon: "ti ti-home-spark" },
      ],
    },
  ];
  const profileOptions = (): FilterChipSection[] => [
    {
      options: [
        { value: "user", label: messages().fullAccount, icon: "ti ti-user-check" },
        { value: "guest", label: messages().guestAccount, icon: "ti ti-user-exclamation" },
      ],
    },
  ];
  const navigate = (patch: Partial<UsersListState>) => {
    navigateTo(
      buildUsersUrl({
        ...props.state,
        ...patch,
        page: 1,
      }),
    );
  };

  return (
    <div class="flex flex-wrap items-center gap-2">
      <FilterChip
        label={messages().managedBy}
        icon="ti ti-building-bank"
        options={providerOptions()}
        value={props.state.provider ? [props.state.provider] : []}
        onValueChange={(value) => navigate({ provider: (value[0] as UsersListState["provider"] | undefined) ?? "" })}
        isActive={props.state.provider.length > 0}
        defaultValue={[]}
      />
      <FilterChip
        label={messages().accessLevel}
        icon="ti ti-badge"
        options={profileOptions()}
        value={props.state.profile ? [props.state.profile] : []}
        onValueChange={(value) => navigate({ profile: (value[0] as UsersListState["profile"] | undefined) ?? "" })}
        isActive={props.state.profile.length > 0}
        defaultValue={[]}
      />
    </div>
  );
}
