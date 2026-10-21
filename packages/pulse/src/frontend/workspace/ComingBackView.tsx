import { Button, Placeholder } from "@k2b/ui";
import { usePulseMessages } from "../use-messages";

export default function ComingBackView(props: { openSources: () => void }) {
  const t = usePulseMessages();
  return (
    <Placeholder
      variant="panel"
      class="flex-1"
      icon="ti ti-chart-area-line"
      title={t().comingBackTitle}
      description={t().comingBackBody}
      action={<Button onClick={props.openSources}>{t().goToSources}</Button>}
    />
  );
}
