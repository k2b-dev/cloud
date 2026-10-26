import { navigateTo } from "@k2b/ssr/nav";
import { FilterChip, type FilterChipSection } from "@k2b/ui";
import { buildGroupsUrl, type GroupsListState } from "../lib/url-state";
import { useAccountsMessages } from "../messages";

type GroupsScopeFilterProps = {
  state: GroupsListState;
  defaultScope: GroupsListState["scope"];
};

const SCOPE_VALUES = new Set<GroupsListState["scope"]>(["managed", "member", "all"]);
const PROVIDER_VALUES = new Set<Exclude<GroupsListState["provider"], never>>(["", "ipa", "local"]);

export default function GroupsScopeFilter(props: GroupsScopeFilterProps) {
  const messages = useAccountsMessages();
  const options = (): FilterChipSection[] => [
    {
      label: messages().membership,
      options: [
        { value: "managed", label: messages().managedByMe, icon: "ti ti-shield-check" },
        { value: "member", label: messages().myGroups, icon: "ti ti-users-group" },
        { value: "all", label: messages().allGroups, icon: "ti ti-layout-grid" },
      ],
    },
    {
      label: messages().origin,
      options: [
        { value: "", label: messages().allOrigins, icon: "ti ti-stack-2" },
        { value: "ipa", label: "FreeIPA", icon: "ti ti-building-fortress" },
        { value: "local", label: messages().local, icon: "ti ti-home" },
      ],
    },
  ];
  return (
    <FilterChip
      label={messages().view}
      icon="ti ti-adjustments-horizontal"
      options={options()}
      value={[props.state.scope, props.state.provider]}
      onValueChange={(value) => {
        const nextScope =
          value.find((entry): entry is GroupsListState["scope"] => SCOPE_VALUES.has(entry as GroupsListState["scope"])) ??
          props.defaultScope;
        const nextProvider =
          value.find((entry): entry is GroupsListState["provider"] => PROVIDER_VALUES.has(entry as GroupsListState["provider"])) ?? "";

        navigateTo(
          buildGroupsUrl(
            {
              ...props.state,
              scope: nextScope,
              provider: nextProvider,
              page: 1,
            },
            { defaultScope: props.defaultScope },
          ),
        );
      }}
      defaultValue={[props.defaultScope, ""]}
    />
  );
}
