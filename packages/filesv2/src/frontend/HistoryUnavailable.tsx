import { InlineGuidance } from "@k2b/ui";
import { FilesApiError } from "./file-preview";
import { useHistoryMessages } from "./history-messages";

export const isHistoryUnavailable = (error: unknown) => error instanceof FilesApiError && error.code === "history_unavailable";

export default function HistoryUnavailable(props: { overview?: boolean }) {
  const h = useHistoryMessages();
  return (
    <InlineGuidance tone="info" icon="ti ti-info-circle" role="status">
      {props.overview ? h().historyOverviewUnavailable : h().historyUnavailable}
    </InlineGuidance>
  );
}
