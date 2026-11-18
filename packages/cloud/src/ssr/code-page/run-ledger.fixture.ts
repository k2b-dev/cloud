import type { CodeOutputWindow } from "../../code/output";
import { codePageFixture } from "./code-page.fixture";

export const RUN_LEDGER_NOW = "2026-11-14T12:49:04.000Z";
export function runLedgerFixture(failed = false) {
  const data = codePageFixture("runs");
  if (data.state.kind !== "ready" || !data.state.run || !data.state.runs) throw new Error("Missing run fixture");
  data.dates.now = RUN_LEDGER_NOW;
  data.state.code.title = "Belege erfassen";
  data.state.runs.items = data.state.runs.items.slice(0, 4);
  data.state.runs.nextCursor = null;
  const run = data.state.run.run;
  Object.assign(run, {
    state: failed ? "failed" : "running",
    title: "Lieferschein #4711",
    trigger: "event",
    createdAt: "2026-11-14T12:48:42.000Z",
    startedAt: "2026-11-14T12:48:42.000Z",
    endedAt: failed ? RUN_LEDGER_NOW : null,
  });
  data.state.runs.items[0] = run;
  if (data.state.words?.runs[run.id])
    Object.assign(data.state.words.runs[run.id]!, {
      title: "Lieferschein #4711",
      state: run.state,
      reason: failed ? "Der Beleg konnte nicht abgelegt werden." : null,
      untilThen: { items: [{ text: "Lieferschein gelesen · 1 bestätigt" }], more: 0, moreText: null },
      complete: failed,
    });
  if (failed) {
    const failure = codePageFixture("run-failed");
    if (failure.state.kind === "ready" && failure.state.run) data.state.run.refusal = failure.state.run.refusal;
  }
  data.state.run.consoleOutput = runLedgerOutput(failed);
  return data;
}
export function runLedgerOutput(failed = false): CodeOutputWindow {
  const at = "2026-11-14T12:48:42.000Z";
  return {
    generation: 1,
    seq: failed ? 2 : 1,
    droppedLines: 0,
    droppedBytes: 0,
    entries: [
      {
        kind: "step",
        id: "1:step:1",
        at,
        label: [{ type: "text", text: "Beleg lesen" }],
        description: [{ type: "text", text: "Liest den Lieferschein und erkennt seine Positionen." }],
        icon: "file-text",
        status: "succeeded",
        startedAt: at,
        endedAt: "2026-11-14T12:48:46.000Z",
      },
      {
        kind: "step",
        id: "1:step:2",
        at,
        label: [{ type: "text", text: "Positionen übernehmen" }],
        icon: "list-check",
        status: failed ? "failed" : "running",
        startedAt: "2026-11-14T12:48:46.000Z",
        ...(failed ? { endedAt: RUN_LEDGER_NOW, message: [{ type: "text" as const, text: "Der Beleg ist gerade nicht verfügbar." }] } : {}),
      },
      { kind: "step", id: "1:step:3", at, label: [{ type: "text", text: "Beleg ablegen" }], icon: "folder", status: "pending" },
      { kind: "log", id: "1:1:0", at, level: "info", text: [{ type: "text", text: "Lieferschein #4711 empfangen" }] },
      { kind: "log", id: "1:1:1", at: "2026-11-14T12:48:46.000Z", level: "info", text: [{ type: "text", text: "14 Positionen erkannt" }] },
      {
        kind: "log",
        id: "1:1:2",
        at: RUN_LEDGER_NOW,
        level: failed ? "error" : "info",
        text: [{ type: "text", text: failed ? "Beleg konnte nicht gelesen werden" : "Positionen werden übernommen" }],
      },
    ],
  };
}
