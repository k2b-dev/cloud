import { useLocale } from "@k2b/ui";
import { Tabs } from "@k2b/ui/v2";
import { areaMessages } from "../../_components/area-messages";
import { ALERTS_PATH } from "../WebhookForm";

export const SETTINGS_HREF = {
  alerts: ALERTS_PATH,
  general: "/admin/observability/settings/general",
} as const;

/** The areas of the settings record in the head: the alerts, and the check with the retention of operational data. */
export function SettingsTabs(props: { current: keyof typeof SETTINGS_HREF }) {
  const locale = useLocale();
  const t = () => areaMessages.resolve([locale()]).t;
  return (
    <Tabs
      label={t().settings}
      items={[
        { label: t().alertsShort, icon: "webhook", href: SETTINGS_HREF.alerts, current: props.current === "alerts" },
        { label: t().generalShort, icon: "heart-rate-monitor", href: SETTINGS_HREF.general, current: props.current === "general" },
      ]}
    />
  );
}
