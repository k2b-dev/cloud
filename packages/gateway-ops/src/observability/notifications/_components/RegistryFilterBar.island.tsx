import { navigateTo } from "@k2b/ssr/nav";
import { FilterChip, type FilterChipSection, useLocale } from "@k2b/ui";
import { SearchBar } from "@k2b/cloud/ssr/islands";
import {
  buildRegistryNotificationsUrl,
  NOTIFICATION_ADMIN_BASE_URL,
  type NotificationAppFilterOption,
  type RegistryStatusFilter,
} from "./filter-state";
import { gatewayOpsMessages } from "../../../messages";

type Props = {
  search: string;
  status: RegistryStatusFilter;
  appIds: string[];
  appOptions: NotificationAppFilterOption[];
};

export default function RegistryFilterBar(props: Props) {
  const { t } = gatewayOpsMessages.resolve([useLocale()()]);
  const statusOptions: FilterChipSection[] = [{ options: [
    { value: "all", label: t.all, icon: "ti ti-list" },
    { value: "active", label: t.active, icon: "ti ti-check", color: "#059669" },
    { value: "inactive", label: t.inactive, icon: "ti ti-archive", color: "#71717a" },
  ] }];
  const navigate = (patch: Partial<Pick<Props, "status" | "appIds">>) =>
    navigateTo(
      buildRegistryNotificationsUrl({
        search: props.search,
        status: patch.status ?? props.status,
        appIds: patch.appIds ?? props.appIds,
      }),
    );
  const appSections = (): FilterChipSection[] => [
    {
      multiple: true,
      options: props.appOptions.map((app) => ({ value: app.id, label: app.label, icon: app.icon })),
    },
  ];
  const searchAction = buildRegistryNotificationsUrl({ search: "", status: props.status, appIds: props.appIds });
  const hasFilters = props.search.length > 0 || props.status !== "all" || props.appIds.length > 0;

  return (
    <div class="flex flex-col gap-2">
      <SearchBar
        action={searchAction}
        value={props.search}
        placeholder={t.searchRegisteredNotifications}
        ariaLabel={t.searchRegistryLabel}
      />
      <div class="flex flex-wrap items-center gap-2">
        <FilterChip
          label={t.status}
          icon="ti ti-filter"
          options={statusOptions}
          value={[props.status]}
          onValueChange={(value) => navigate({ status: (value[0] ?? "all") as RegistryStatusFilter })}
          isActive={props.status !== "all"}
          defaultValue={["all"]}
        />
        {props.appOptions.length > 0 && (
          <FilterChip
            label={t.app}
            icon="ti ti-apps"
            options={appSections()}
            value={props.appIds}
            onValueChange={(appIds) => navigate({ appIds })}
            isActive={props.appIds.length > 0}
            defaultValue={[]}
          />
        )}
        {hasFilters && (
          <a
            href={`${NOTIFICATION_ADMIN_BASE_URL}?view=registry`}
            class="hidden text-[10px] tabular-nums text-red-500 sm:inline"
            aria-label={t.clearAllFilters}
          >
            <i class="ti ti-x" /> {t.clear}
          </a>
        )}
      </div>
    </div>
  );
}
