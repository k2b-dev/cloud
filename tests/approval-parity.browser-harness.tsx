import { LocaleProvider } from "@k2b/ui";
import { Bar, Pane, Tabs, Text } from "@k2b/ui/v2";
import { createSignal, Show } from "solid-js";
import { render } from "solid-js/web";
import { approvalModel, approvalStates } from "../packages/assistant/src/frontend/code-version-card.test-fixture";
import { CodeVersionCardView } from "../packages/assistant/src/frontend/code-version-card-view";
import { toolActionCard } from "../packages/cloud/src/ai/chat/action-card";
import { actionFixtures } from "../packages/cloud/src/ai/chat/action-question.fixtures";
import { legacyOutcomeWords } from "../packages/cloud/src/ai/chat/tool-action-words";
import { ApprovalCard } from "../packages/cloud/src/approvals/ApprovalCard";
import CodePage from "../packages/cloud/src/ssr/code-page/CodePage";
import { type CodePageFixtureState, codePageFixture } from "../packages/cloud/src/ssr/code-page/code-page.fixture";
import { reviewProps } from "../packages/core/src/pages/admin/code/ApprovalsScreen";
import type { FixtureReviewVariant } from "../packages/core/src/pages/admin/code/CodeArea.fixture-data";
import { codeAdminMessages } from "../packages/core/src/pages/admin/code/messages";
import { createCodeReview, ReviewBody, ReviewDialog, reviewHeadActions } from "../packages/core/src/pages/admin/code/review";
import { codeReviewMessages } from "../packages/core/src/pages/admin/code/review-messages";

declare global {
  interface Window {
    approvalAdminFixtures: Record<
      FixtureReviewVariant,
      ReturnType<typeof import("../packages/core/src/pages/admin/code/CodeArea.fixture-data").fixtureApprovalDetail>
    >;
  }
}
const params = new URLSearchParams(location.search);
const [state, show] = createSignal(params.get("state") ?? "waiting");
const family = params.get("family") ?? "code";
const locale = params.get("locale") === "en" ? "en" : "de";
const fixtures = actionFixtures(locale);
const mail = fixtures.mail!.block;
const card = toolActionCard(mail, { locale, timeZone: "Europe/Berlin", outcome: legacyOutcomeWords(mail, locale, "Europe/Berlin") });
const capStates = ["open", "sending", "done", "declined", "expired", "failed", "unknown"];
const capLine = () => {
  const s = state();
  return s === "sending"
    ? { tone: "running" as const, text: card.forms.running }
    : s === "done"
      ? { tone: "done" as const, text: card.forms.done, time: "09:49" }
      : s === "declined"
        ? { tone: "off" as const, text: card.forms.rejected, detail: "Du hast abgelehnt." }
        : s === "expired"
          ? {
              tone: "off" as const,
              text: [{ kind: "text" as const, text: "Die Frage ist abgelaufen." }],
              action: {
                label: "Noch einmal fragen",
                onSelect: () => {
                  show("open");
                },
              },
            }
          : s === "failed"
            ? {
                tone: "error" as const,
                text: [{ kind: "text" as const, text: "Die Freigabe konnte nicht gespeichert werden." }],
                action: {
                  label: "Erneut versuchen",
                  onSelect: () => {
                    show("open");
                  },
                },
              }
            : {
                tone: "warning" as const,
                text: card.forms.unknown,
                detail: "Prüf den Stand, bevor du es noch einmal versuchst",
                action: {
                  label: "Stand prüfen",
                  onSelect: () => {
                    show("done");
                  },
                },
              };
};
const capability = () => (
  <ApprovalCard
    card={card}
    state={state() === "open" ? "open" : state() === "sending" ? "sending" : state() === "expired" ? "expired" : "decided"}
    outcome={{ current: state(), lines: { [state()]: capLine() } }}
    timeZone="Europe/Berlin"
    remember={{
      onSelect: () => {
        show("done");
      },
    }}
    onConfirm={() => {
      show("sending");
    }}
    onDecline={() => {
      show("declined");
    }}
  />
);
const code = () => (
  <CodeVersionCardView
    model={approvalModel(approvalStates.find((s) => s === state()) ?? "waiting", locale)}
    anchorId="parity-code"
    onAction={() => {}}
  />
);
const adminStates: FixtureReviewVariant[] = ["normal", "own", "sole", "approved", "rejected", "changes", "withdrawn", "followup"];
/**
 * The admin review as Administration › Code › Freigaben opens it on v2: the version's props as the screen maps them,
 * its deeds in the detail head, its views under it and the statement with the overview in the pane.
 */
function Admin() {
  const detail = window.approvalAdminFixtures[adminStates.find((s) => s === state()) ?? "normal"];
  const t = codeAdminMessages.resolve([locale]).t;
  const r = codeReviewMessages.resolve([locale]).t;
  const base = {
    apps: {},
    viewerId: "11111111-1111-4111-8111-111111111111",
    dateConfig: { locale, timeZone: "Europe/Berlin" },
    query: { sec: "approvals" as const, id: detail.version.id },
  };
  const review = createCodeReview(reviewProps(base, r, detail, [], t.unknownAuthor, detail.ownerName ?? t.unknownAuthor));
  return (
    <div class="k2-ui">
      <Pane
        detail
        label={r.headTitle({ title: review.props.title, n: review.props.number })}
        head={
          <Bar
            start={
              <Text type="body" weight="strong">
                {review.props.title}
              </Text>
            }
            end={reviewHeadActions(review)}
          />
        }
        status={<Bar start={<Tabs label={r.tabsLabel} items={review.tabs()} />} />}
      >
        <ReviewBody review={review} />
      </Pane>
      <ReviewDialog review={review} />
    </div>
  );
}
const pageStates: CodePageFixtureState[] = ["new-version", "approval", "changes-requested", "versions-rejected"];
Object.assign(window, { approvalParity: { show, capStates, adminStates, codeStates: approvalStates, pageStates } });
render(
  () => (
    <LocaleProvider locale={locale}>
      <main
        id="parity"
        style={{ "max-width": family === "admin" || family === "page" ? "72rem" : "48rem", margin: "0 auto", padding: "24px 16px" }}
      >
        <Show when={family === "capability"}>{capability()}</Show>
        <Show when={family === "code"}>{code()}</Show>
        <Show when={family === "mixed"}>
          {capability()}
          {code()}
        </Show>
        <Show when={family === "admin"}>
          <Admin />
        </Show>
        <Show when={family === "page"}>
          <CodePage data={codePageFixture(pageStates.find((s) => s === state()) ?? "new-version", locale)} onLive={() => undefined} />
        </Show>
        <p id="following">Danach geht die Unterhaltung weiter.</p>
      </main>
    </LocaleProvider>
  ),
  document.getElementById("root")!,
);
