import { Button, NoticeCard } from "@k2b/ui";
import { Show } from "solid-js";
import { platformMessages } from "../ssr/platform-messages";

export default function PanelLeaveNotice(props: { blocked: boolean; locale: string; resume: () => void }) {
  const t = () => platformMessages.resolve([props.locale]).t;
  return (
    <Show when={props.blocked}>
      <div role="status" data-cloud-panel-leave="blocked">
        <NoticeCard tone="warning" title={t().panelLeaveBlocked} detail={t().panelLeaveDetail}>
          <Button variant="ghost" onClick={props.resume}>
            {t().panelLeaveResume}
          </Button>
        </NoticeCard>
      </div>
    </Show>
  );
}
