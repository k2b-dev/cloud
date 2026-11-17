import { LocaleProvider } from "@k2b/ui";
import { createMemo, createSignal } from "solid-js";
import { render } from "solid-js/web";
import AssistantCodeDecisionLine from "./AssistantCodeDecisionLine";
import AssistantCodeVersionCard from "./AssistantCodeVersionCard";
import { AssistantLiveProvider, createAssistantLiveHub } from "./assistant-live";
import { type ApprovalState, approvalFixture, approvalModel, approvalStates, approvalVersionId } from "./code-version-card.test-fixture";
import { describeCodeVersionCard } from "./code-version-card-state";
import { CodeVersionCardView } from "./code-version-card-view";

const query = new URLSearchParams(location.search);
const locale = query.get("lang") === "en" ? "en" : "de";
const [state, setState] = createSignal<ApprovalState>("waiting");
const [extra, setExtra] = createSignal<"loading" | "failed" | "denied" | null>(null);
const model = createMemo(() => {
  const value = extra();
  return value
    ? describeCodeVersionCard({
        value: value === "loading" ? null : value,
        version: 1,
        versionId: approvalVersionId,
        locale,
        timeZone: "UTC",
        activation: { kind: "idle" },
        nextRun: null,
        canAsk: true,
      })
    : approvalModel(state(), locale);
});
const root = document.createElement("main");
root.style.cssText = "max-width: 48rem; margin: 0 auto; padding: 24px 16px";
(document.querySelector(".app-accent-scope") ?? document.body).append(root);
await Promise.all(["400 14px 'IBM Plex Sans'", "500 14px 'IBM Plex Sans'", "16px tabler-icons"].map((font) => document.fonts.load(font)));

let finish: (() => void) | undefined;
if (query.get("mode") === "interactive") {
  const fixture = approvalFixture("ready", locale);
  window.fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      const path = String(input);
      let data: unknown;
      if (path.endsWith("/activation/preview")) data = fixture.preview;
      else if (path.endsWith("/review")) data = fixture.review;
      else if (path.endsWith("/code.version.words")) data = fixture.words;
      else if (path.endsWith("/code.read")) data = { code: fixture.code };
      else if (path.endsWith("/code.version.read")) data = { pages: fixture.pages };
      else if (path.endsWith("/activate")) {
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        data = { state: "failed", failure: null };
      } else throw new Error(`Unexpected fixture route ${path}`);
      return new Response(JSON.stringify({ data }), { headers: { "content-type": "application/json" } });
    },
    { preconnect: window.fetch.preconnect },
  );
}
render(
  () => (
    <LocaleProvider locale={locale}>
      <AssistantLiveProvider value={createAssistantLiveHub()}>
        {query.get("mode") === "interactive" ? (
          <AssistantCodeVersionCard codeId="c_info01" versionId={approvalVersionId} number={1} timeZone="UTC" />
        ) : (
          <CodeVersionCardView model={model()} anchorId={`code-version-${approvalVersionId}`} onAction={() => {}} />
        )}
        <p id="following">{locale === "de" ? "Danach geht das Gespräch weiter." : "The conversation continues below."}</p>
        <AssistantCodeDecisionLine
          decision={{
            codeId: "c_info01",
            versionId: approvalVersionId,
            number: 1,
            outcome: "approved",
            person: { id: "u-jana", name: "Jana Probe" },
            anchor: `code-version-${approvalVersionId}`,
          }}
          at="2026-11-17T08:30:00.000Z"
          timeZone="UTC"
        />
      </AssistantLiveProvider>
    </LocaleProvider>
  ),
  root,
);
Object.assign(window, {
  setApprovalState: (value: string) => {
    const normal = approvalStates.find((state) => state === value);
    if (normal) {
      setExtra(null);
      setState(normal);
    } else if (value === "loading" || value === "failed" || value === "denied") setExtra(value);
  },
  failActivation: () => finish?.(),
});
