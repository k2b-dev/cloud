import { LocaleProvider } from "@k2b/ui";
import { render } from "solid-js/web";
import CodePage from "./CodePage";
import { runLedgerFixture } from "./run-ledger.fixture";

render(() => <LocaleProvider locale="de"><div data-k2b-primary="ai"><CodePage data={runLedgerFixture()} onLive={() => undefined} /></div></LocaleProvider>, document.getElementById("root")!);
