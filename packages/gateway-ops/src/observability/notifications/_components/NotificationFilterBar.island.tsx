import { navigateTo } from "@k2b/ssr/nav";
import { FilterChip, type FilterChipSection, useLocale } from "@k2b/ui";
import { SearchBar } from "@k2b/cloud/ssr/islands";
import { buildLegacyNotificationsUrl, type LegacyNotificationStatusFilter, NOTIFICATION_ADMIN_BASE_URL } from "./filter-state";
import SendAllPending from "./SendAllPending";
import { gatewayOpsMessages } from "../../../messages";

export type NotificationStatusFilter = LegacyNotificationStatusFilter;

type Props = {
  search: string;
  status: NotificationStatusFilter;
};

const buildNotificationsUrl = (filter: { search?: string; status?: NotificationStatusFilter }) => {
  return buildLegacyNotificationsUrl({ search: filter.search ?? "", status: filter.status ?? "all" });
};

export default function NotificationFilterBar(props: Props) {
  const { t } = gatewayOpsMessages.resolve([useLocale()()]);
  const statusOptions: FilterChipSection[] = [{ options: [
    { value: "all", label: t.all, icon: "ti ti-list" },
    { value: "pending", label: t.pending, icon: "ti ti-clock", color: "#d97706" },
    { value: "sent", label: t.sent, icon: "ti ti-check", color: "#059669" },
    { value: "error", label: t.error, icon: "ti ti-alert-circle", color: "#ef4444" },
  ] }];
  const searchAction = buildNotificationsUrl({ status: props.status });

  const setStatus = (value: string[]) => {
    const status = (value[0] ?? "all") as NotificationStatusFilter;
    navigateTo(buildNotificationsUrl({ search: props.search, status }));
  };

  const hasFilters = props.search.length > 0 || props.status !== "all";

  return (
    <div class="flex flex-col gap-2">
      <SearchBar action={searchAction} value={props.search} placeholder={t.searchNotifications} ariaLabel={t.searchNotifications} />
      <div class="flex items-center gap-2 flex-wrap">
        <FilterChip
          label={t.status}
          icon="ti ti-filter"
          options={statusOptions}
          value={[props.status]}
          onValueChange={setStatus}
          isActive={props.status !== "all"}
          defaultValue={["all"]}
        />
        {hasFilters && (
          <a
            href={`${NOTIFICATION_ADMIN_BASE_URL}?view=legacy`}
            class="hidden text-[10px] tabular-nums text-red-500 sm:inline"
            aria-label={t.clearAllFilters}
          >
            <i class="ti ti-x" /> {t.clear}
          </a>
        )}
        <div class="ml-auto">
          <SendAllPending />
        </div>
      </div>
    </div>
  );
}
