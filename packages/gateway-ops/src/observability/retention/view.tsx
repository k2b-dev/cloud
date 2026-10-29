import { type Attention, areaText, ObservabilityArea, ObservabilityPane } from "../_components/ObservabilityArea";
import RetentionForm, { type RetentionValues } from "./RetentionForm.island";

export function RetentionView(props: {
  c: Parameters<typeof ObservabilityArea>[0]["c"];
  locale: string;
  attention: Attention;
  values: RetentionValues;
  unreadable: Partial<Record<keyof RetentionValues, boolean>>;
}) {
  const t = areaText(props.locale);
  return (
    <ObservabilityArea c={props.c} locale={props.locale} section="retention" attention={props.attention}>
      <ObservabilityPane label={t.retention} description={t.retentionDescription} saveStatus>
        <RetentionForm values={props.values} unreadable={props.unreadable} />
      </ObservabilityPane>
    </ObservabilityArea>
  );
}
