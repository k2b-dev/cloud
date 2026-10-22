import { LocaleProvider } from "@k2b/ui";
import { historySnapshot } from "./History.browser-fixtures";
import Workspace from "./Workspace.island";

/** The same real workspace and fixed snapshot render on the server and mount in the browser. */
export default function HistoryHarness(props: { source: string; locale: string }) {
  return (
    <LocaleProvider locale={props.locale}>
      <Workspace
        initial={historySnapshot(props.source)}
        cloudUrl="http://files-history.test"
        timeZone="Europe/Berlin"
        retentionDays={365}
      />
    </LocaleProvider>
  );
}
