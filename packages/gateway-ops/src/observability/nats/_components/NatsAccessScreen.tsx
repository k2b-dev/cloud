import { useLocale } from "@k2b/ui";
import { Bar, Pane, Text, Workspace } from "@k2b/ui/v2";
import { NatsSyncViewTabs, type ObservabilityAreaNav, ObservabilityNav } from "../../_components/ObservabilityNav";
import { SettingsSaveBar, settingsSaveAction } from "../../_components/SettingsSaveBar";
import { natsMessages } from "../messages";
import NatsAccessForm, { type NatsAccessValues } from "../NatsAccessForm";

export type NatsAccessScreenProps = {
  area: ObservabilityAreaNav;
  values: NatsAccessValues;
  accessRequired?: boolean;
  unreadable: Record<"servers" | "kind" | "access" | "ca", boolean>;
};

/** The separate system-account connection for cluster diagnostics, saved from the head. */
export default function NatsAccessScreen(props: NatsAccessScreenProps) {
  const locale = useLocale();
  const t = () => natsMessages.resolve([locale()]).t;
  return (
    <Workspace
      sidebar={<ObservabilityNav area={props.area} current="nats" />}
      primary={settingsSaveAction(locale())}
      head={<Bar start={<NatsSyncViewTabs current="access" />} end={<SettingsSaveBar />} />}
    >
      <Pane label={t().access}>
        <Text type="body" muted>
          {t().accessDescription}
        </Text>
        <NatsAccessForm values={props.values} unreadable={props.unreadable} accessRequired={props.accessRequired} />
      </Pane>
    </Workspace>
  );
}
