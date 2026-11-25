import { AdminWorkspace } from "@k2b/cloud/ssr/islands";
import { useLocale } from "@k2b/ui";
import { Bar, type NavProps, Pane, Text } from "@k2b/ui/v2";
import { areaMessages } from "../../_components/area-messages";
import { SettingsSaveBar } from "../../_components/SettingsSaveBar";
import HealthCheckForm, { type HealthCheckValues } from "../HealthCheckForm";
import RetentionForm, { type RetentionValues } from "../RetentionForm";
import { SettingsTabs } from "./SettingsTabs";

export type SettingsFormScreenProps = { nav: NavProps } & (
  | { area: "health"; values: HealthCheckValues; unreadable: Partial<Record<keyof HealthCheckValues, boolean>> }
  | { area: "retention"; values: RetentionValues; unreadable: Partial<Record<keyof RetentionValues, boolean>> }
);

/** Health check or retention: one form, saved from the head. */
export default function SettingsFormScreen(props: SettingsFormScreenProps) {
  const locale = useLocale();
  const t = () => areaMessages.resolve([locale()]).t;
  return (
    <AdminWorkspace nav={props.nav} head={<Bar start={<SettingsTabs current={props.area} />} end={<SettingsSaveBar />} />}>
      <Pane label={props.area === "health" ? t().healthCheck : t().retention}>
        <Text type="body" muted>
          {props.area === "health" ? t().healthCheckDescription : t().retentionDescription}
        </Text>
        {props.area === "health" ? (
          <HealthCheckForm values={props.values} unreadable={props.unreadable} />
        ) : (
          <RetentionForm values={props.values} unreadable={props.unreadable} />
        )}
      </Pane>
    </AdminWorkspace>
  );
}
