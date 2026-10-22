import { expect, test } from "bun:test";
import { compactStoredReview, storedReviewWithContent } from "../ai/review-content";
import { readCapabilityResponse } from "../capabilities/response";
import { restoreReviewSnapshot, serializeReviewSnapshot } from "../capabilities/review-storage";
import { capabilityReviewFormIssues } from "../capabilities/reviews";
import {
  CAPABILITY_MAX_REVIEW_CONTENT_BYTES,
  CAPABILITY_MAX_REVIEW_RESPONSE_BYTES,
  CapabilityActionReviewDataSchema,
  CapabilityReviewContentSchema,
} from "../contracts/capabilities";
import { approvalReviewDigest } from "../services/approvals";
import { serializeCapabilityProviderResult } from "./capabilities";
import { reviewFixture } from "./capability-review.test-fixture";
import { capabilityActionReviewIssues } from "./capability-reviews";

const content = (body: string) => ({
  kind: "message" as const,
  from: { name: "Sender", address: "sender@example.com" },
  to: [],
  subject: "Proposed draft",
  body,
  format: "plain" as const,
});

test("complete unsaved text, including control characters, survives a dedicated review response; ordinary results keep their bound", async () => {
  const review = { ...reviewFixture(), content: content(`${"x".repeat(300_000)}\u202e\u0000END`) };
  expect(CapabilityActionReviewDataSchema.safeParse(review).success).toBe(true);
  expect(capabilityReviewFormIssues(review)).toEqual([]);
  const response = serializeCapabilityProviderResult({ ok: true, data: review }, { review: true });
  expect(response.status).toBe(200);
  const result = await readCapabilityResponse(
    new Response(response.body),
    CapabilityActionReviewDataSchema,
    CAPABILITY_MAX_REVIEW_RESPONSE_BYTES,
  );
  expect(result).toEqual({ ok: true, data: review });
  expect(serializeCapabilityProviderResult({ ok: true, data: review }).status).not.toBe(200);
  expect((await readCapabilityResponse(new Response(response.body), CapabilityActionReviewDataSchema)).ok).toBe(false);
});

test("16 MiB measures serialized UTF-8 content and fails instead of cutting a valid-looking prefix", () => {
  const overhead = new TextEncoder().encode(JSON.stringify(content(""))).byteLength;
  const exact = content("x".repeat(CAPABILITY_MAX_REVIEW_CONTENT_BYTES - overhead));
  expect(CapabilityReviewContentSchema.safeParse(exact).success).toBe(true);
  expect(CapabilityReviewContentSchema.safeParse({ ...exact, body: `${exact.body}x` }).success).toBe(false);
  expect(CapabilityReviewContentSchema.safeParse(content("\u0000".repeat(3 * 1024 * 1024))).success).toBe(false);
});

test("full content participates in approval identity while compact snapshots and forks retain a bounded reader", () => {
  const review = { ...reviewFixture(), content: content(`${"x".repeat(65_536)}tail`) };
  const location = {
    conversationId: "11111111-1111-4111-8111-111111111111",
    turnId: "22222222-2222-4222-8222-222222222222",
    callId: "send/1",
  };
  const stored = storedReviewWithContent(review, location);
  const compact = compactStoredReview(stored, location);
  expect("content" in compact).toBe(false);
  expect(JSON.stringify(compact).length).toBeLessThan(2048);
  expect(approvalReviewDigest(review)).not.toBe(approvalReviewDigest({ ...review, content: content(`${"x".repeat(65_536)}changed`) }));
  if (!("contentRef" in compact)) throw new Error("Missing content reference");
  expect(compact.contentRef?.href).toEndWith("/reviews/send%2F1");
  const fork = compactStoredReview(stored, { ...location, conversationId: "33333333-3333-4333-8333-333333333333" });
  if (!("contentRef" in fork)) throw new Error("Missing fork reference");
  expect(fork.contentRef?.digest).toBe(compact.contentRef?.digest);
  expect(fork.contentRef?.href).not.toBe(compact.contentRef?.href);
});

test("stored full content preserves NUL and lone surrogates without JSONB-incompatible text values", () => {
  const review = { ...reviewFixture(), content: content("before\u0000\ud800after\udc00") };
  const encoded = serializeReviewSnapshot(review);
  const stored = JSON.parse(encoded);
  expect(typeof stored.content).toBe("string");
  expect(stored.content).not.toContain("\u0000");
  expect(stored.content.isWellFormed()).toBe(true);
  expect(restoreReviewSnapshot(stored)).toEqual(review);
  expect(approvalReviewDigest(CapabilityActionReviewDataSchema.parse(restoreReviewSnapshot(stored)))).toBe(approvalReviewDigest(review));
  expect(CapabilityActionReviewDataSchema.safeParse(restoreReviewSnapshot({ ...stored, content: "broken" })).success).toBe(false);
});

test("declared sends requires full recipients regardless of the per-call ask", () => {
  for (const ask of [undefined, "deletes", "sends"] as const) {
    const review = { ...reviewFixture(), ask, content: content("Entire proposal") };
    const context = { policy: { ask: "sends" } as const, queries: [], validateQueryInput: () => false };
    expect(capabilityActionReviewIssues(review, context)).toContain("Full sends content requires a recipient");
    expect(
      capabilityActionReviewIssues({ ...review, content: { ...review.content, bcc: [{ address: "to@example.test" }] } }, context),
    ).toEqual([]);
  }
  expect(
    capabilityActionReviewIssues(
      { ...reviewFixture(), content: content("Recipient-free draft") },
      {
        policy: { ask: "app_asks" },
        queries: [],
        validateQueryInput: () => false,
      },
    ),
  ).toEqual([]);
});

test("the combined Mail maximum fits the full-content budget even with six-byte JSON escapes", () => {
  const person = { name: "\u0000".repeat(200), address: "\u0000".repeat(320) };
  const people = Array.from({ length: 200 }, () => person);
  const maximal = {
    ...content("\u0000".repeat(2 * 1024 * 1024)),
    from: person,
    to: people,
    cc: people,
    bcc: people,
    subject: "\u0000".repeat(998),
    attachments: Array.from({ length: 202 }, () => ({ name: "\u0000".repeat(255), size: Number.MAX_SAFE_INTEGER })),
    warnings: Array.from({ length: 6 }, () => "\u0000".repeat(300)),
    sendAt: "2026-10-20T06:00:00Z",
    baseRevision: 7,
  };
  expect(CapabilityReviewContentSchema.safeParse(maximal).success).toBe(true);
  expect(new TextEncoder().encode(JSON.stringify(maximal)).byteLength).toBeLessThan(CAPABILITY_MAX_REVIEW_CONTENT_BYTES);
});

test("compact review text rejects lone surrogates while full content preserves them", () => {
  const review = { ...reviewFixture(), content: content("full\ud800content") };
  expect(CapabilityActionReviewDataSchema.safeParse(review).success).toBe(true);
  expect(
    CapabilityActionReviewDataSchema.safeParse({
      ...review,
      preview: { kind: "page", title: "Draft", body: "short\ud800text", format: "plain" },
    }).success,
  ).toBe(false);
});
