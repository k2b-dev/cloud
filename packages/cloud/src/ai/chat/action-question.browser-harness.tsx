import { LocaleProvider } from "@k2b/ui";
import { render } from "solid-js/web";
import { ApprovalCard } from "../../approvals/ApprovalCard";
import Approvals from "../../approvals/Approvals";
import type { ApprovalPage } from "../../contracts/approvals";
import { toolActionCard } from "./action-card";
import { actionFixtures, FIXTURE_AT } from "./action-question.fixtures";
import { legacyOutcomeWords } from "./tool-action-words";

const params = new URLSearchParams(location.search);
const draft = params.get("draft") === "1";
const block = actionFixtures("de").mail!.block;
const review = block.review;
if (!review || !("sentence" in review)) throw new Error("Missing view fixture");
const sharedReview = { ...review, draft: { editable: draft, fields: ["subject", "body"] } };
const card = toolActionCard(
  { ...block, review: sharedReview },
  {
    locale: "de",
    timeZone: "UTC",
    outcome: legacyOutcomeWords(block, "de", "UTC"),
  },
);
const initial: ApprovalPage = {
  items: [
    {
      id: "00000000-0000-4000-8000-000000000001",
      app: { id: "mail", name: "Mail", icon: "ti ti-mail" },
      action: "draft.send",
      assurance: "confirm",
      sentence: "Send draft",
      review: sharedReview,
      requester: { kind: "chat", appId: "assistant", title: "Mail", href: "/app/assistant" },
      remember: { chat: false, always: false, website: false },
      createdAt: FIXTURE_AT,
      expiresAt: "2026-10-18T12:02:00.000Z",
    },
  ],
  count: 1,
  elsewhere: 0,
  nextCursor: null,
};
const root = document.createElement("main");
root.style.cssText = `width: min(100%, 764px); margin: 0 auto; padding-top: 16px;`;
document.body.append(root);
const Shared = () => (
  <ApprovalCard
    card={card}
    state="open"
    timeZone="UTC"
    expiresAt={initial.items[0]!.expiresAt}
    onConfirm={() => {}}
    onDecline={() => {}}
    onEditDraft={draft ? async () => true : undefined}
    outcome={{ lines: {}, current: "" }}
  />
);
render(
  () => (
    <LocaleProvider locale="de">
      <div data-host="chat">
        <Shared />
      </div>
      {!draft && (
        <>
          <aside
            data-host="panel"
            data-k2b-layer="flat"
            data-k2b-primary="blue"
            style={{ "--ui-action-primary-surface": "#2563eb", "--k2b-action": "#2563eb" }}
          >
            <Shared />
          </aside>
          <div data-host="page">
            <Approvals app="mail" initial={initial} />
          </div>
        </>
      )}
    </LocaleProvider>
  ),
  root,
);
