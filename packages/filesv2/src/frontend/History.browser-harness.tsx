import { LocaleProvider, PageTrailProvider } from "@k2b/ui";
import { historySnapshot } from "./History.browser-fixtures";
import Workspace from "./Workspace.island";

/** The same real workspace and fixed snapshot render on the server and mount in the browser. */
export default function HistoryHarness(props: { source: string; locale: string }) {
  return (
    <LocaleProvider locale={props.locale}>
      <PageTrailProvider trail={{ title: props.locale === "de" ? "Aktivität" : "Activity", ancestors: [] }}>
        <Workspace initial={historySnapshot(props.source)} timeZone="Europe/Berlin" retentionDays={365} />
      </PageTrailProvider>
    </LocaleProvider>
  );
}
