import { type Attention, areaText, ObservabilityArea, ObservabilityPane } from "../_components/ObservabilityArea";
import HealthCheckForm from "./HealthCheckForm.island";

export function HealthCheckView(props: {
  c: Parameters<typeof ObservabilityArea>[0]["c"];
  locale: string;
  attention: Attention;
  schedule: string;
  unreadable: boolean;
}) {
  const t = areaText(props.locale);
  return (
    <ObservabilityArea c={props.c} locale={props.locale} section="healthCheck" attention={props.attention}>
      <ObservabilityPane label={t.healthCheck} description={t.healthCheckDescription} saveStatus>
        <HealthCheckForm schedule={props.schedule} unreadable={props.unreadable} />
      </ObservabilityPane>
    </ObservabilityArea>
  );
}
