import type { AiStoredMessage } from "@k2b/cloud/ai";
import { LocaleProvider } from "@k2b/ui";
import { render } from "solid-js/web";
import DecisionLine from "./AssistantCodeDecisionLine";
import { AssistantCodeDecisionEntry } from "./code-decision-deferred";
import type { CodeDecisionPages } from "./code-decision-pages";

declare global {
  interface Window {
    decisionFixture: { pages?: CodeDecisionPages | null; pageCount?: number; locale: string; deferred?: boolean; replaced?: boolean };
  }
}
const fixture = window.decisionFixture;
const decision = {
  codeId: "c_delivery",
  versionId: "v_demo",
  number: 3,
  outcome: "activated" as const,
  pageCount: fixture.pageCount,
  person: { id: null, name: null },
  anchor: "version-3",
};
const entry: AiStoredMessage = {
  id: "event",
  shortId: "Event",
  conversationId: "chat",
  seq: 1,
  kind: "message",
  message: { role: "user", content: [{ type: "text", text: "Cloud activation fact" }] },
  loopId: null,
  modelId: null,
  providerModel: null,
  usage: null,
  stopReason: null,
  loopAggregate: null,
  loopDoneReason: null,
  compactedAt: null,
  createdAt: "2026-11-17T09:30:00Z",
  meta: { codeDecision: decision },
};
const messages = [
  entry,
  ...(fixture.replaced ? [{ ...entry, id: "newer", seq: 2, meta: { codeDecision: { ...decision, versionId: "v_new", number: 4 } } }] : []),
];
render(
  () => (
    <LocaleProvider locale={fixture.locale}>
      <main
        class="k2b-ui"
        style="padding:24px;max-width:740px;margin:10vh auto;--app-ink-light:#8e1b6f;--app-ink-dark:#bf7dad;--app-selected-light:#f7eff5;--app-selected-dark:#231627;--app-selected-nav-light:#f4e8f1;--app-selected-nav-dark:#261629"
      >
        {fixture.deferred ? (
          <AssistantCodeDecisionEntry entry={entry} messages={() => messages} timeZone="UTC" />
        ) : (
          <DecisionLine decision={decision} at={entry.createdAt} timeZone="UTC" pages={fixture.pages} />
        )}
      </main>
    </LocaleProvider>
  ),
  document.getElementById("root")!,
);
