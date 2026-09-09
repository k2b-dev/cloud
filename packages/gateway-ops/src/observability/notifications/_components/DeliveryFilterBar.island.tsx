import { navigateTo } from "@k2b/ssr/nav";
import { FilterChip, type FilterChipSection, useLocale } from "@k2b/ui";
import { SearchBar } from "@k2b/cloud/ssr/islands";
import {
  buildDeliveryNotificationsUrl,
  type DeliveryStatusFilter,
  NOTIFICATION_ADMIN_BASE_URL,
  type NotificationAppFilterOption,
  notificationChannelIcon,
  notificationChannelLabel,
} from "./filter-state";
import { gatewayOpsMessages } from "../../../messages";

type Props = {
  search: string;
  status: DeliveryStatusFilter;
  channels: string[];
  appIds: string[];
  channelOptions: string[];
  appOptions: NotificationAppFilterOption[];
};

export default function DeliveryFilterBar(props: Props) {
  const { t } = gatewayOpsMessages.resolve([useLocale()()]);
  const statusOptions: FilterChipSection[] = [{ options: [
    { value: "all", label: t.all, icon: "ti ti-list" },
    { value: "pending", label: t.pending, icon: "ti ti-clock", color: "#d97706" },
    { value: "sending", label: t.sending, icon: "ti ti-send", color: "#2563eb" },
    { value: "delivered", label: t.delivered, icon: "ti ti-check", color: "#059669" },
    { value: "suppressed", label: t.suppressed, icon: "ti ti-bell-off", color: "#71717a" },
    { value: "failed", label: t.failed, icon: "ti ti-alert-circle", color: "#ef4444" },
    { value: "deferred", label: t.deferred, icon: "ti ti-player-pause", color: "#71717a" },
  ] }];
  const navigate = (patch: Partial<Pick<Props, "status" | "channels" | "appIds">>) =>
    navigateTo(
      buildDeliveryNotificationsUrl({
        search: props.search,
        status: patch.status ?? props.status,
        channels: patch.channels ?? props.channels,
        appIds: patch.appIds ?? props.appIds,
      }),
    );
  const channelSections = (): FilterChipSection[] => [
    {
      multiple: true,
      options: props.channelOptions.map((channel) => ({
        value: channel,
        label: channel === "email" ? t.email : channel === "browser" ? t.browser : notificationChannelLabel(channel),
        icon: notificationChannelIcon(channel),
      })),
    },
  ];
  const appSections = (): FilterChipSection[] => [
    {
      multiple: true,
      options: props.appOptions.map((app) => ({ value: app.id, label: app.label, icon: app.icon })),
    },
  ];
  const searchAction = buildDeliveryNotificationsUrl({ search: "", status: props.status, channels: props.channels, appIds: props.appIds });
  const hasFilters = props.search.length > 0 || props.status !== "all" || props.channels.length > 0 || props.appIds.length > 0;

  return (
    <div class="flex flex-col gap-2">
      <SearchBar action={searchAction} value={props.search} placeholder={t.searchDeliveries} ariaLabel={t.searchDeliveriesLabel} />
      <div class="flex flex-wrap items-center gap-2">
        <FilterChip
          label={t.status}
          icon="ti ti-filter"
          options={statusOptions}
          value={[props.status]}
          onValueChange={(value) => navigate({ status: (value[0] ?? "all") as DeliveryStatusFilter })}
          isActive={props.status !== "all"}
          defaultValue={["all"]}
        />
        {props.channelOptions.length > 0 && (
          <FilterChip
            label={t.channel}
            icon="ti ti-route"
            options={channelSections()}
            value={props.channels}
            onValueChange={(channels) => navigate({ channels })}
            isActive={props.channels.length > 0}
            defaultValue={[]}
          />
        )}
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
            href={NOTIFICATION_ADMIN_BASE_URL}
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
