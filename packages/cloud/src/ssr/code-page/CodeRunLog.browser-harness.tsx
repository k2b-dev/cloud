import { LocaleProvider } from "@k2b/ui";
import { render } from "solid-js/web";
import CodePage from "./CodePage";
import { runLedgerFixture } from "./run-ledger.fixture";

const query = new URLSearchParams(window.location.search);
const data = runLedgerFixture(query.has("failed"));
if (data.state.kind === "ready" && query.has("reader")) data.state.permission = "reader";
render(() => <LocaleProvider locale="de"><div data-k2b-primary="ai"><CodePage data={data} onLive={() => undefined} /></div></LocaleProvider>, document.getElementById("root")!);
