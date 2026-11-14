import { expect, test } from "bun:test";
import { reviewFixture } from "../_internal/capability-review.test-fixture";
import { blocksText } from "../blocks/text";
import { CapabilityActionReviewPresentationSchema } from "../contracts/capabilities";
import { capabilityRequestHash } from "./claims";
import { legacyReviewView, presentReview } from "./legacy-review-view";
import { restoreReviewSnapshot, serializeReviewSnapshot } from "./review-storage";
import { boundReviewView } from "./reviews";

const review = (preview: unknown, locale = "en") => {
  const { view: _view, ...base } = reviewFixture();
  return { ...base, locale, preview, links: [{ rel: "open" as const, href: "/app/demo/full" }] };
};
const cases = [
  {
    kind: "message",
    from: { name: "Ops", address: "ops@example.com" },
    to: [{ name: "Lea" }],
    cc: [{ name: "Cc" }],
    bcc: [{ name: "Bcc" }],
    subject: "Subject",
    body: "Excerpt",
    format: "plain",
    more: { bcc: 3 },
    attachments: [{ name: "a.pdf" }],
    moreAttachments: 2,
    sendAt: "2026-10-17T12:00:00Z",
    warnings: ["External"],
    truncated: true,
  },
  {
    kind: "page",
    title: "Page",
    place: "Office",
    body: "Excerpt",
    format: "plain",
    changes: [{ change: "added", text: "New" }],
    truncated: true,
  },
  { kind: "event", title: "Event", start: "2026-10-17", description: "Description", attendees: [{ name: "Lea" }] },
  { kind: "task", title: "Task", status: "Open", checklist: [{ label: "Check", done: false }] },
  { kind: "file", name: "a.png", path: "/tmp/a.png", mediaType: "image/png" },
  { kind: "rule", when: { text: "On change" }, does: "Notify", may: [{ text: "Read" }], seesChat: false },
  { kind: "fields", rows: [{ label: "Title", value: "New", before: "Old" }] },
];
for (const locale of ["en", "de"])
  for (const preview of cases)
    test(`legacy ${preview.kind} ${locale}: localized blocks, unchanged persisted digest`, () => {
      const raw = review(preview, locale);
      const digest = capabilityRequestHash(raw);
      const converted = CapabilityActionReviewPresentationSchema.parse(legacyReviewView(raw));
      if (!("sentence" in converted)) throw new Error("Review missing");
      expect(converted.view?.blocks.length).toBeGreaterThan(0);
      expect(converted.draft?.editable).toBe(false);
      expect(capabilityRequestHash(restoreReviewSnapshot(JSON.parse(serializeReviewSnapshot(raw))))).toBe(digest);
      expect(raw).toHaveProperty("preview");
      const text = blocksText(boundReviewView(converted)!.blocks, { locale, timeZone: "UTC" });
      if (preview.kind === "message")
        for (const item of [
          "Ops",
          "Lea",
          "Cc",
          "Bcc",
          "a.pdf",
          "External",
          "Excerpt",
          locale === "de" ? "und 3 weitere" : "and 3 more",
          locale === "de" ? "Gekürzt" : "Shortened",
        ])
          expect(text).toContain(item);
      if (preview.kind === "page") expect(text).toContain("New");
      if (preview.kind === "file") expect(converted.view!.blocks.some((b) => b.kind === "Image")).toBe(false);
      if ("truncated" in preview) {
        expect(converted.incomplete).toBe(true);
        expect(converted.links).toEqual(raw.links);
      }
    });
test("full historical snapshot outranks excerpt without rewriting the old locator", () => {
  const raw = {
    ...review(cases[0]),
    content: { kind: "message", subject: "Full", body: "Complete text", format: "plain", to: [{ name: "Lea" }] },
    contentRef: { href: "/api/approvals/11111111-1111-4111-8111-111111111111/content", digest: "a".repeat(64) },
  };
  const output = CapabilityActionReviewPresentationSchema.parse(presentReview(raw));
  if (!("sentence" in output)) throw new Error("Review missing");
  expect(JSON.stringify(output.view)).toContain("Complete text");
  expect(output.contentRef).toEqual(raw.contentRef);
  expect(output.draft?.editable).toBe(false);
});
