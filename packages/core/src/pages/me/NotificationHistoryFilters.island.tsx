import { navigateTo } from "@k2b/ssr/nav";
import { FilterChip, type FilterChipSection, useLocale } from "@k2b/ui";
import type { NotificationDeliveryStatus } from "@valentinkolb/cloud/contracts";
import { accountMessages } from "./messages";

export default function NotificationHistoryFilters(props: { status?: NotificationDeliveryStatus }) {
  const locale = useLocale();
  const t = () => accountMessages.resolve([locale()]).t;
  const statusOptions = (): FilterChipSection[] => [
    {
      options: [
        { value: "all", label: t().all, icon: "ti ti-list" },
        { value: "delivered", label: t().delivered, icon: "ti ti-check" },
        { value: "pending", label: t().pending, icon: "ti ti-clock" },
        { value: "failed", label: t().failed, icon: "ti ti-alert-triangle" },
        { value: "suppressed", label: t().notSent, icon: "ti ti-bell-off" },
      ],
    },
  ];
  const setStatus = (value: string) => {
    const params = new URLSearchParams(window.location.search);
    params.delete("page");
    if (value === "all") params.delete("status");
    else params.set("status", value);
    const query = params.toString();
    navigateTo(query ? `/me/notifications/history?${query}` : "/me/notifications/history");
  };

  return (
    <FilterChip
      label={t().status}
      icon="ti ti-filter"
      options={statusOptions()}
      value={[props.status ?? "all"]}
      onValueChange={(value) => setStatus(value[0] ?? "all")}
      isActive={props.status !== undefined}
      defaultValue={["all"]}
      position="bottom-right"
      iconOnly
    />
  );
}
