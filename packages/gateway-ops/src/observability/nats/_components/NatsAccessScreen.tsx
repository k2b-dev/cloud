import { AdminWorkspace } from "@k2b/cloud/ssr/islands";
import { useLocale } from "@k2b/ui";
import { Bar, type NavProps, Pane, Text } from "@k2b/ui/v2";
import { InfrastructureTabs } from "../../_components/InfrastructureTabs";
import { SettingsSaveBar, settingsSaveAction } from "../../_components/SettingsSaveBar";
import { natsMessages } from "../messages";
import NatsAccessForm, { type NatsAccessValues } from "../NatsAccessForm";

export type NatsAccessScreenProps = {
  nav: NavProps;
  values: NatsAccessValues;
  accessRequired?: boolean;
  unreadable: Record<"servers" | "kind" | "access" | "ca", boolean>;
};

/** The separate system-account connection for cluster diagnostics, saved from the head. */
export default function NatsAccessScreen(props: NatsAccessScreenProps) {
  const locale = useLocale();
  const t = () => natsMessages.resolve([locale()]).t;
  return (
    <AdminWorkspace
      nav={props.nav}
      primary={settingsSaveAction(locale())}
      head={<Bar start={<InfrastructureTabs current="access" />} end={<SettingsSaveBar />} />}
    >
      <Pane label={t().access}>
        <Text type="body" muted>
          {t().accessDescription}
        </Text>
        <NatsAccessForm values={props.values} unreadable={props.unreadable} accessRequired={props.accessRequired} />
      </Pane>
    </AdminWorkspace>
  );
}
