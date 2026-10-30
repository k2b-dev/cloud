import { type Attention, NatsSyncTabs, ObservabilityArea, ObservabilityPane } from "../_components/ObservabilityArea";
import { natsMessages } from "./messages";
import NatsAccessForm, { type NatsAccessValues } from "./NatsAccessForm.island";

export function NatsAccessView(props: {
  c: Parameters<typeof ObservabilityArea>[0]["c"];
  locale: string;
  attention: Attention;
  values: NatsAccessValues;
  unreadable: Record<"servers" | "kind" | "access" | "ca", boolean>;
}) {
  const { t } = natsMessages.resolve([props.locale]);
  return (
    <ObservabilityArea c={props.c} locale={props.locale} section="nats" attention={props.attention}>
      <ObservabilityPane label={t.access} description={t.accessDescription} saveStatus>
        <NatsSyncTabs current="access" locale={props.locale} />
        <NatsAccessForm values={props.values} unreadable={props.unreadable} />
      </ObservabilityPane>
    </ObservabilityArea>
  );
}
