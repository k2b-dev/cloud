import { expect, test } from "bun:test";
import { reviewFixture } from "../../_internal/capability-review.test-fixture";
import type { Block } from "../../blocks/schema";
import { blocksText } from "../../blocks/text";
import { legacyReviewView } from "../../capabilities/legacy-review-view";
import { type CapabilityActionCallReview, CapabilityActionReviewPresentationSchema } from "../../contracts/capabilities";
import { reviewActionCard } from "./action-card";
import { actionCardText, actionQuestionLines } from "./action-text";

const ctx = { locale: "en", timeZone: "UTC", app: { name: "Mail", icon: "ti ti-mail" } };
const cards = (blocks: Block[]) => reviewActionCard({ ...reviewFixture(), view: { version: 1, blocks } }, ctx);
test("all review blocks use the shared text projection in CLI questions", () => {
  const blocks: Block[] = [
    {
      kind: "Draft",
      context: [
        { label: "From", value: "ops@example.com" },
        { label: "To", value: [{ name: "Lea", address: "lea@example.com" }] },
      ],
      fields: [
        { name: "subject", label: "Subject", type: "text", value: "Meeting" },
        { name: "body", label: "Body", type: "textarea", value: "Hello\nLea\t!" },
      ],
    },
    { kind: "Notice", tone: "warning", title: "External", text: "Leaves Cloud" },
    { kind: "Detail", title: "Changes", items: [{ label: "Status", value: "New", before: "Old" }] },
  ];
  const card = cards(blocks);
  const text = actionCardText(card);
  expect(text.rows).toEqual([{ label: "Text", value: blocksText(blocks, { locale: "en", timeZone: "UTC" }), block: true }]);
  expect(text.incomplete).toBe(false);
  const lines = actionQuestionLines(text, { timeZone: "UTC", commands: { approve: "approve", reject: "reject" } }).join("\n");
  for (const value of ["ops@example.com", "lea@example.com", "Hello", "Old", "Leaves Cloud", "approve", "reject"])
    expect(lines).toContain(value);
});
test("large views cannot claim completeness before the contentRef is loaded", () => {
  const card = cards([{ kind: "Text", text: "Excerpt" }]);
  card.contentRef = { href: "/api/approvals/11111111-1111-4111-8111-111111111111/content", digest: "a".repeat(64) };
  expect(actionCardText(card).incomplete).toBe(true);
  delete card.contentRef;
  expect(actionCardText(card).rows[0]?.value).toBe("Excerpt");
});
test("legacy truncation retains its open link and read-all semantics", () => {
  const { view: _view, ...raw } = reviewFixture();
  const converted = CapabilityActionReviewPresentationSchema.parse(
    legacyReviewView({
      ...raw,
      preview: { kind: "page", title: "Page", body: "Excerpt", format: "plain", truncated: true },
      links: [{ rel: "open", href: "/app/demo/full" }],
    }),
  );
  if (!("sentence" in converted)) throw new Error("Missing review");
  const text = actionCardText(reviewActionCard(converted, ctx));
  expect(text.incomplete).toBe(true);
  expect(text.readMore).toBe("/app/demo/full");
  expect(actionQuestionLines(text, { timeZone: "UTC" }).join("\n")).toContain("Read all");
});
test("slot values omitted by the question must appear in blocks or keep the question incomplete", () => {
  const people = ["a", "b", "c", "d"].map((name) => ({ name, address: `${name}@example.com` }));
  const review: CapabilityActionCallReview = {
    ...reviewFixture(),
    sentence: { action: "Send to {to}", running: "Sending to {to}", done: "Sent to {to}", confirm: "Send", decline: "Keep" },
    slots: { to: { kind: "person" as const, people } },
    view: undefined,
  };
  expect(actionCardText(reviewActionCard(review, ctx)).incomplete).toBe(true);
  review.view = { version: 1, blocks: [{ kind: "Text", text: people.map((p) => `${p.name} <${p.address}>`).join(", ") }] };
  expect(actionCardText(reviewActionCard(review, ctx)).incomplete).toBe(false);
});
test("consequences, old literals and read-more line limits remain visible", () => {
  const card = cards([{ kind: "Text", text: Array.from({ length: 12 }, (_, i) => `Line ${i + 1}`).join("\n") }]);
  card.consequences = [{ text: [], plain: "Also saves", mark: "added" }];
  expect(actionCardText(card).rows.at(-1)).toMatchObject({ label: "Added", value: "Also saves" });
  expect(actionQuestionLines(actionCardText(card), { timeZone: "UTC" }).join("\n")).toContain("Line 12");
  card.readMore = "/app/demo/full";
  expect(actionQuestionLines(actionCardText(card), { timeZone: "UTC" }).join("\n")).not.toContain("Line 12");
});
