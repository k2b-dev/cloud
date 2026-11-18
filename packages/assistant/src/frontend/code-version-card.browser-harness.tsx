import type { AiStoredMessage } from "@k2b/cloud/ai";
import { AiChatActionsProvider, createAiChatTimeline } from "@k2b/cloud/ai/ui";
import { Chat, LocaleProvider } from "@k2b/ui";
import { createMemo, createSignal } from "solid-js";
import { render } from "solid-js/web";
import AssistantAuthoringStop from "./AssistantAuthoringStop";
import AssistantCodeDecisionLine from "./AssistantCodeDecisionLine";
import AssistantCodeVersionCard from "./AssistantCodeVersionCard";
import { AssistantLiveProvider, createAssistantLiveHub } from "./assistant-live";
import { createStoppedAuthoringFixture } from "./authoring-stop.test-fixture";
import {
  type ApprovalState,
  approvalFixture,
  approvalModel,
  approvalSnapshot,
  approvalStates,
  approvalVersionId,
} from "./code-version-card.test-fixture";
import { ApprovalSnapshotView } from "./code-version-card-ssr.test-fixture";
import { describeCodeVersionCard } from "./code-version-card-state";
import { CodeVersionCardView } from "./code-version-card-view";

const query = new URLSearchParams(location.search);
const locale = query.get("lang") === "en" ? "en" : "de";
const mode = query.get("mode");
const [state, setState] = createSignal<ApprovalState>(mode === "comparison" ? "ready" : "waiting");
const [extra, setExtra] = createSignal<
  "loading" | "failed" | "denied" | "unknown" | "checking" | "on-single-page" | "pages-unavailable" | "refresh-failed" | null
>(null);
const model = createMemo(() => {
  const value = extra();
  if (value === "on-single-page" || value === "pages-unavailable" || value === "refresh-failed") {
    const loaded = approvalFixture("on", locale);
    if (value === "pages-unavailable") loaded.pages = null;
    else if (value === "refresh-failed") loaded.refreshFailed = true;
    else if (loaded.pages) loaded.pages.pages = loaded.pages.pages.slice(0, 1);
    return describeCodeVersionCard({
      value: loaded,
      version: 1,
      versionId: approvalVersionId,
      locale,
      timeZone: "UTC",
      activation: { kind: "idle" },
      nextRun: null,
      canAsk: true,
    });
  }
  return value
    ? describeCodeVersionCard({
        value: value === "loading" ? null : value === "unknown" || value === "checking" ? approvalFixture("ready", locale) : value,
        version: 1,
        versionId: approvalVersionId,
        locale,
        timeZone: "UTC",
        activation: { kind: value === "unknown" || value === "checking" ? value : "idle" },
        nextRun: null,
        canAsk: true,
      })
    : approvalModel(state(), locale);
});
const root = document.querySelector<HTMLElement>("#snapshot-root") ?? document.createElement("main");
root.style.cssText = "max-width: 48rem; margin: 0 auto; padding: 24px 16px";
if (!root.isConnected) (document.querySelector(".app-accent-scope") ?? document.body).append(root);
await Promise.all(["400 14px 'IBM Plex Sans'", "500 14px 'IBM Plex Sans'", "16px tabler-icons"].map((font) => document.fonts.load(font)));

let finish: ((ok: boolean) => void) | undefined;
let active = mode === "snapshot";
let reads = 0;
if (mode === "interactive" || mode === "snapshot") {
  window.fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      const path = String(input);
      let data: unknown;
      if (path.endsWith("/code.version.cards")) {
        reads++;
        data = {
          items: [
            {
              codeId: "c_info01",
              versionId: approvalVersionId,
              state: "available",
              snapshot: approvalSnapshot(active ? "on" : "ready", locale),
            },
          ],
        };
      } else if (path.endsWith("/activate")) {
        const ok = await new Promise<boolean>((resolve) => {
          finish = resolve;
        });
        active = ok;
        data = { state: ok ? "active" : "failed", failure: null };
      } else throw new Error(`Unexpected fixture route ${path}`);
      return new Response(JSON.stringify({ data }), { headers: { "content-type": "application/json" } });
    },
    { preconnect: window.fetch.preconnect },
  );
}
const initial = [
  { codeId: "c_info01", versionId: approvalVersionId, state: "available" as const, snapshot: approvalSnapshot("on", locale) },
];
const snapshotBefore =
  mode === "snapshot"
    ? { text: root.innerText, rect: root.querySelector(".assistant-code-version")?.getBoundingClientRect().toJSON() }
    : null;
// @k2b/ssr replaces an island's server output with its first browser render. Both use the same snapshot here.
if (mode === "snapshot") root.replaceChildren();
const stopped = mode === "comparison" ? await createStoppedAuthoringFixture(locale, "model_calls", "version") : null;
const comparisonMessages: AiStoredMessage[] = stopped
  ? [
      stopped.messages[0]!,
      {
        ...stopped.messages[1]!,
        id: "submit-call",
        seq: 2,
        meta: null,
        loopDoneReason: null,
        message: { role: "assistant", content: [{ type: "tool_call", id: "submit", name: "code_submit", args: { codeId: "c_info01" } }] },
      },
      {
        ...stopped.messages[1]!,
        id: "submit-result",
        seq: 3,
        meta: null,
        loopDoneReason: null,
        message: {
          role: "tool_result",
          callId: "submit",
          name: "code_submit",
          result: { submission: { version: { id: approvalVersionId, number: 1 } } },
          isError: false,
        },
      },
      { ...stopped.messages[1]!, seq: 4 },
    ]
  : [];
const [retired, setRetired] = createSignal(false);
const ComparisonTimeline = () => {
  const items = createAiChatTimeline({ messages: () => comparisonMessages, activeTurn: () => null });
  return <Chat.Timeline items={items()} />;
};
const Comparison = () => {
  return (
    <AiChatActionsProvider
      actions={{
        renderCodeVersion: () => <CodeVersionCardView model={model()} anchorId="comparison-approval" onAction={() => {}} />,
        renderCodeAuthoringStop: (stop, canContinue) => (
          <AssistantAuthoringStop state={stop} continuable={canContinue} superseded={retired} />
        ),
        onContinueTurn: async () => {},
      }}
    >
      <Chat>
        <ComparisonTimeline />
      </Chat>
    </AiChatActionsProvider>
  );
};
render(
  () =>
    mode === "snapshot" ? (
      <ApprovalSnapshotView initial={initial} locale={locale} />
    ) : (
      <LocaleProvider locale={locale}>
        <AssistantLiveProvider value={createAssistantLiveHub()}>
          {mode === "comparison" ? (
            <Comparison />
          ) : mode === "interactive" ? (
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
    } else if (
      value === "loading" ||
      value === "failed" ||
      value === "denied" ||
      value === "unknown" ||
      value === "checking" ||
      value === "on-single-page" ||
      value === "pages-unavailable" ||
      value === "refresh-failed"
    )
      setExtra(value);
  },
  finishActivation: (ok: boolean) => finish?.(ok),
  setRetired,
  snapshotBefore,
  cardReadCount: () => reads,
});
