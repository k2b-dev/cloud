import { type Attention, areaText, ObservabilityArea, ObservabilityPane } from "../_components/ObservabilityArea";
import HealthCheckForm, { type HealthCheckValues } from "./HealthCheckForm.island";

export function HealthCheckView(props: {
  c: Parameters<typeof ObservabilityArea>[0]["c"];
  locale: string;
  attention: Attention;
  values: HealthCheckValues;
  unreadable: Partial<Record<keyof HealthCheckValues, boolean>>;
}) {
  const t = areaText(props.locale);
  return (
    <ObservabilityArea c={props.c} locale={props.locale} section="healthCheck" attention={props.attention}>
      <ObservabilityPane label={t.healthCheck} description={t.healthCheckDescription} saveStatus>
        <HealthCheckForm values={props.values} unreadable={props.unreadable} />
      </ObservabilityPane>
    </ObservabilityArea>
  );
}
