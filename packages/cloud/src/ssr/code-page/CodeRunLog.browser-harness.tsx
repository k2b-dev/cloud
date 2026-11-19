import { LocaleProvider } from "@k2b/ui";
import { render } from "solid-js/web";
import CodePage from "./CodePage";
import { runLedgerFixture } from "./run-ledger.fixture";

const query = new URLSearchParams(window.location.search);
const data = runLedgerFixture(query.has("failed"));
if (data.state.kind === "ready" && query.has("reader")) {
  data.state.permission = "reader";
  if (data.state.run?.refusal) data.state.run.refusal.call = null;
}
render(
  () => (
    <LocaleProvider locale="de">
      <div data-k2b-primary="ai">
        <CodePage
          data={data}
          onLive={(feed) => {
            const cancel = () => {
              if (data.state.kind === "ready" && data.state.run) feed.run({ ...data.state.run.run, state: "cancelled" });
            };
            window.addEventListener("fixture-reader-cancelled", cancel);
            return () => window.removeEventListener("fixture-reader-cancelled", cancel);
          }}
        />
      </div>
    </LocaleProvider>
  ),
  document.getElementById("root")!,
);
