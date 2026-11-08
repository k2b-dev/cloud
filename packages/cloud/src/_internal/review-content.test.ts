import { expect, test } from "bun:test";
import { compactStoredReview, storedReviewWithContent } from "../ai/review-content";
import { capabilityRequestHash } from "../capabilities/claims";
import { presentReview } from "../capabilities/legacy-review-view";
import { readCapabilityResponse } from "../capabilities/response";
import { restoreReviewSnapshot, serializeReviewSnapshot } from "../capabilities/review-storage";
import { boundReviewView } from "../capabilities/reviews";
import {
  CAPABILITY_MAX_REVIEW_CONTENT_BYTES,
  CAPABILITY_MAX_REVIEW_RESPONSE_BYTES,
  CapabilityActionReviewDataSchema,
  CapabilityActionReviewPresentationSchema,
} from "../contracts/capabilities";
import { approvalReviewDigest } from "../services/approvals";
import { serializeCapabilityProviderResult } from "./capabilities";
import { reviewFixture } from "./capability-review.test-fixture";
import { capabilityActionReviewIssues } from "./capability-reviews";

const view = (text: string) => ({ version: 1 as const, blocks: [{ kind: "Text" as const, text }] });
const context = { policy: { ask: "sends" } as const, queries: [], validateQueryInput: () => false };
const location = {
  conversationId: "11111111-1111-4111-8111-111111111111",
  turnId: "22222222-2222-4222-8222-222222222222",
  callId: "send/1",
};

test("complete passive views survive the review response, ordinary results stay bounded", async () => {
  const review = { ...reviewFixture(), view: view(`${"x".repeat(300000)}\u0000END`) };
  expect(capabilityActionReviewIssues(review, context)).toEqual([]);
  const response = serializeCapabilityProviderResult({ ok: true, data: review }, { review: true });
  expect(response.status).toBe(200);
  expect(
    await readCapabilityResponse(new Response(response.body), CapabilityActionReviewDataSchema, CAPABILITY_MAX_REVIEW_RESPONSE_BYTES),
  ).toEqual({ ok: true, data: review });
  expect(serializeCapabilityProviderResult({ ok: true, data: review }).status).not.toBe(200);
});
test("16 MiB counts the serialized view including its envelope", () => {
  const overhead = Buffer.byteLength(JSON.stringify(view("")));
  const review = { ...reviewFixture(), view: view("x".repeat(CAPABILITY_MAX_REVIEW_CONTENT_BYTES - overhead)) };
  expect(capabilityActionReviewIssues(review, context)).toEqual([]);
  review.view.blocks[0]!.text += "x";
  expect(capabilityActionReviewIssues(review, context).length).toBeGreaterThan(0);
});
test("inline bound views stop at 32 KiB and fork locators preserve their digest", () => {
  for (const delta of [0, 1]) {
    const overhead = Buffer.byteLength(JSON.stringify(view("")));
    const review = { ...reviewFixture(), view: view("x".repeat(32768 - overhead + delta)) };
    const stored = storedReviewWithContent(review, location);
    const compact = compactStoredReview(stored, location);
    expect("view" in compact).toBe(delta === 0);
    expect("contentRef" in compact).toBe(delta !== 0);
    const presented = presentReview(stored, true);
    expect(presented && typeof presented === "object" && "view" in presented).toBe(delta === 0);
    if (delta) {
      expect(compact).toMatchObject({ contentRef: { digest: capabilityRequestHash(boundReviewView(review)) } });
      const fork = compactStoredReview(stored, { ...location, conversationId: "33333333-3333-4333-8333-333333333333" });
      expect(fork).toMatchObject({ contentRef: { digest: capabilityRequestHash(boundReviewView(review)) } });
      expect(JSON.stringify(fork)).not.toBe(JSON.stringify(compact));
    }
  }
});
test("storage roundtrips NUL and lone surrogates without changing request identity", () => {
  const review = { ...reviewFixture(), view: view("before\u0000\ud800after\udc00") };
  const stored = JSON.parse(serializeReviewSnapshot(review));
  expect(typeof stored.view).toBe("string");
  expect(stored.view).not.toContain("\u0000");
  expect(stored.view.isWellFormed()).toBe(true);
  expect(restoreReviewSnapshot(stored)).toEqual(review);
  expect(approvalReviewDigest(CapabilityActionReviewDataSchema.parse(restoreReviewSnapshot(stored)))).toBe(approvalReviewDigest(review));
});
test("Drafts require top-level input keys, sender context, and the 256 KiB budget", () => {
  const review = {
    ...reviewFixture(),
    view: {
      version: 1 as const,
      blocks: [
        {
          kind: "Draft" as const,
          context: [{ label: "From", value: "ops@example.com" }],
          fields: [{ name: "body", label: "Body", type: "textarea" as const, value: "text" }],
        },
      ],
    },
  };
  expect(capabilityActionReviewIssues(review, context)).toContain("Draft fields must name top-level Action input properties");
  const ctx = { ...context, inputSchema: { properties: { body: { type: "string" } } } };
  expect(capabilityActionReviewIssues(review, ctx)).toEqual([]);
  review.view.blocks[0]!.fields[0]!.value = "x".repeat(256 * 1024);
  expect(capabilityActionReviewIssues(review, ctx).length).toBeGreaterThan(0);
});

test("compacting an already converted historical view preserves its complete-content locator", () => {
  const { view: _view, ...base } = reviewFixture();
  const raw = {
    ...base,
    preview: { kind: "page", title: "Old", body: "Excerpt", format: "plain", truncated: true },
    contentRef: { href: "/api/approvals/11111111-1111-4111-8111-111111111111/content", digest: "a".repeat(64) },
  };
  const converted = CapabilityActionReviewPresentationSchema.parse(presentReview(raw));
  const compact = compactStoredReview(converted as Parameters<typeof compactStoredReview>[0], location);
  expect(compact).toHaveProperty("contentRef.digest", raw.contentRef.digest);
  expect(compact).toHaveProperty("incomplete", true);
  expect(compact).toHaveProperty("draft.editable", false);
});

test("storage records bound byte size without changing raw bindings or the request digest", () => {
  const key = "x".repeat(500);
  const table = { kind: "Table" as const, title: "Rows", columns: [{ path: ["name"], label: "Name" }] };
  const review = {
    ...reviewFixture(),
    view: {
      version: 1 as const,
      blocks: [
        { ...table, rows: [{ [key]: [] }] },
        ...Array.from({ length: 200 }, () => ({ ...table, rows: { from: ["view", "blocks", "0", "rows", "0", key] } })),
      ],
    },
  };
  const digest = approvalReviewDigest(review);
  const stored = JSON.parse(serializeReviewSnapshot(review));
  expect(Buffer.byteLength(stored.view)).toBeGreaterThan(32768);
  expect(stored._boundViewBytes).toBeLessThan(32768);
  expect(restoreReviewSnapshot(stored)).toEqual(review);
  expect(approvalReviewDigest(CapabilityActionReviewDataSchema.parse(restoreReviewSnapshot(stored)))).toBe(digest);
});
