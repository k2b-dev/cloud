import { LocaleProvider } from "@k2b/ui";
import { render } from "solid-js/web";
import CodePage from "./CodePage";
import { codePageFixture } from "./code-page.fixture";
import { RUN_LEDGER_NOW, runLedgerFixture } from "./run-ledger.fixture";

const query = new URLSearchParams(window.location.search);
const data = query.has("list") ? codePageFixture("runs-list") : runLedgerFixture(query.has("failed"));
if (data.state.kind === "ready") {
  data.state.code.title = "Belege erfassen";
  if (query.has("list")) {
    for (const [index, run] of (data.state.runs?.items ?? []).entries()) {
      const words = data.state.words?.runs[run.id];
      if (words)
        words.title = index === 1 ? "Lieferschein mit zusätzlichen Positionen für die gesamte Lieferung geprüft" : "Aufgabe angelegt";
    }
  }
  if (query.has("empty") && data.state.run) {
    Object.assign(data.state.run.run, { state: "succeeded", outcome: "succeeded", endedAt: RUN_LEDGER_NOW });
    data.state.run.consoleOutput = { generation: 1, seq: 0, entries: [], droppedLines: 0, droppedBytes: 0 };
  }
}
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
