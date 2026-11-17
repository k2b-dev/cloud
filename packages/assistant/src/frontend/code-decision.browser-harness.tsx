import { LocaleProvider } from "@k2b/ui";
import { render } from "solid-js/web";
import DecisionLine from "./AssistantCodeDecisionLine";
import type { CodeDecisionPages } from "./code-decision-pages";

declare global {
  interface Window {
    decisionFixture: { pages?: CodeDecisionPages | null; pageCount?: number; locale: string };
  }
}
const fixture = window.decisionFixture;
render(
  () => (
    <LocaleProvider locale={fixture.locale}>
      <main
        class="k2b-ui"
        style="padding:24px;max-width:740px;margin:10vh auto;--app-ink-light:#8e1b6f;--app-ink-dark:#bf7dad;--app-selected-light:#f7eff5;--app-selected-dark:#231627;--app-selected-nav-light:#f4e8f1;--app-selected-nav-dark:#261629"
      >
        <DecisionLine
          decision={{
            codeId: "c_delivery",
            versionId: "v_demo",
            number: 3,
            outcome: "activated",
            pageCount: fixture.pageCount,
            person: { id: null, name: null },
            anchor: "version-3",
          }}
          at="2026-11-17T09:30:00Z"
          timeZone="UTC"
          pages={fixture.pages}
        />
      </main>
    </LocaleProvider>
  ),
  document.getElementById("root")!,
);
