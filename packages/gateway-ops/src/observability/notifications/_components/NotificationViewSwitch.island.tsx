import { navigateTo } from "@k2b/ssr/nav";
import { SegmentedControl, useLocale } from "@k2b/ui";
import { buildNotificationViewUrl, type NotificationAdminView } from "./filter-state";
import { gatewayOpsMessages } from "../../../messages";

export default function NotificationViewSwitch(props: { view: NotificationAdminView }) {
  const { t } = gatewayOpsMessages.resolve([useLocale()()]);
  const options = [
    { value: "deliveries", label: t.deliveryAttemptsView, icon: "ti ti-route" },
    { value: "registry", label: t.registryView, icon: "ti ti-list-details" },
    { value: "legacy", label: t.legacyView, icon: "ti ti-mail" },
  ] satisfies Array<{ value: NotificationAdminView; label: string; icon: string }>;
  return (
    <SegmentedControl
      options={options}
      value={() => props.view}
      onValueChange={(view) => navigateTo(buildNotificationViewUrl(view))}
      ariaLabel={t.notificationView}
    />
  );
}
