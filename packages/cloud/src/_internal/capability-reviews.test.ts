import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { assertCapabilityReview, checkActionReviewMessages } from "../capabilities/testing";
import { ApprovalPageSchema } from "../contracts/approvals";
import {
  CAPABILITY_MAX_REVIEW_BYTES,
  type CapabilityActionDefinition,
  CapabilityActionManifestSchema,
  type CapabilityActionPolicy,
  CapabilityActionReviewDataSchema,
  CapabilityManifestSchema,
  type CapabilitySlot,
  capabilityActionPolicy,
  capabilityResultSchema,
} from "../contracts/capabilities";
import {
  capabilityHash,
  capabilityManifestEvolutionIssues,
  compileCapabilities,
  parseCapabilityManifest,
  resolveCapabilityManifestPresentation,
  reviewCompiledCapability,
  validateCapabilityResult,
} from "./capabilities";
import { compileReviewFixture, receiptCases, reviewCases, reviewFixture } from "./capability-review.test-fixture";
import { actionReview, capabilityActionReviewIssues, capabilityReviewRememberScope, capabilityReviewView } from "./capability-reviews";

const context = {
  actor: {
    kind: "service_account" as const,
    serviceAccount: {
      id: "11111111-1111-4111-8111-111111111111",
      name: "Test",
      kind: "standalone" as const,
      status: "active" as const,
      delegatedUserId: null,
      appId: null,
      resourceType: null,
      resourceId: null,
      createdBy: null,
      createdAt: "2026-10-17T00:00:00.000Z",
    },
    delegatedUser: null,
    scopes: ["read"],
    credentialId: "22222222-2222-4222-8222-222222222222",
  },
  accessSubject: { type: "service_account" as const, serviceAccountId: "11111111-1111-4111-8111-111111111111" },
  user: null,
  locale: "en",
  requestId: "test",
  origin: "http" as const,
  signal: new AbortController().signal,
};
const reviewContext = { policy: { ask: "sends" } as const, queries: [], validateQueryInput: () => false };

describe("shared review validation at the producer", () => {
  for (const { name, review: wire, valid, policy } of reviewCases())
    test(name, async () => {
      const compiled = compileReviewFixture(policy);
      const action = compiled.actions.get("send")!;
      const review = reviewFixture();
      for (const key of Object.keys(review)) Reflect.deleteProperty(review, key);
      Object.assign(review, wire);
      action.definition.review = () => ({ ok: true, data: review });
      const errors: unknown[] = [];
      const result = await reviewCompiledCapability({
        compiled,
        localId: "send",
        input: {},
        expectedSchemaHash: action.manifest.schemaHash,
        context,
        onUnexpectedError: (error) => errors.push(error),
      });
      expect(result.ok).toBe(valid);
      if (!valid) {
        expect(result).toMatchObject({
          ok: false,
          error: { code: "INVALID_APP_RESPONSE", status: 500, message: "Capability review returned an invalid result" },
        });
        expect(errors).toHaveLength(1);
      } else if (result.ok) expect(result.data).toBe(review);
    });
  for (const { name, receipt, links, valid } of receiptCases())
    test(`producer receipt: ${name}`, () => {
      const compiled = compileReviewFixture();
      const result = validateCapabilityResult(compiled, compiled.actions.get("send")!, { data: {}, receipt, ...(links ? { links } : {}) });
      expect(result.ok).toBe(valid);
      if (!valid) expect(result).toMatchObject({ ok: false, error: { code: "INVALID_APP_RESPONSE", status: 500 } });
    });
  test("silent reach only narrows; scope never bypasses per-call ask", () => {
    const review = reviewFixture();
    const silent = { ...reviewContext, policy: { silent: "draft" } as const };
    expect(capabilityActionReviewIssues({ ...review, reach: "you" }, silent)).toEqual([]);
    expect(capabilityActionReviewIssues({ ...review, reach: "shared" }, silent)).not.toEqual([]);
    expect(capabilityReviewRememberScope({ ...review, scope: "mail" }, "rememberable")).toBe("mail");
    expect(capabilityReviewRememberScope({ ...review, scope: "mail", ask: "sends" }, "rememberable")).toBeUndefined();
    expect(capabilityReviewRememberScope({ message: "Legacy", approvalScope: "mail" }, "rememberable")).toBe("mail");
    expect(capabilityReviewRememberScope({ ...review, scope: "mail" }, undefined)).toBeUndefined();
    expect(capabilityReviewRememberScope({ ...review, scope: "mail" }, "none")).toBeUndefined();
    expect(capabilityActionReviewIssues(review, { queries: [], validateQueryInput: () => false })).not.toEqual([]);
  });
  test("sends review completeness reports each issue once", () => {
    const review = reviewFixture();
    review.ask = "sends";
    if (review.preview?.kind !== "message") throw new Error("Expected message preview");
    delete review.preview.from;
    review.preview.more = { to: 1 };
    review.preview.truncated = true;
    delete review.links;
    const issues = capabilityActionReviewIssues(review, reviewContext);
    expect(issues).toHaveLength(3);
    expect(issues.filter((issue) => issue === "A sends message requires from")).toHaveLength(1);
    expect(new Set(issues).size).toBe(issues.length);
  });
  test("receipt validation at the result seam and consumer future receipt tolerance", () => {
    const compiled = compileReviewFixture(),
      action = compiled.actions.get("send")!,
      query = compiled.queries.get("check")!;
    for (const receipt of [
      { text: "{missing}" },
      {
        text: "Done",
        preview: {
          kind: "message",
          from: { address: "ops@example.com" },
          to: [{ name: "Lea" }],
          subject: "Hi",
          body: "Hello",
          format: "plain",
          more: { bcc: 1 },
        },
      },
      { text: "Done", preview: { kind: "page", title: "Page", body: "Text", format: "plain", truncated: true } },
    ]) {
      expect(validateCapabilityResult(compiled, action, { data: {}, receipt }).ok).toBe(false);
      expect(validateCapabilityResult(compiled, action, { data: {}, receipt, links: [{ rel: "open", href: "/app/demo" }] }).ok).toBe(
        receipt.text === "Done",
      );
    }
    expect(validateCapabilityResult(compiled, action, { data: {}, receipt: { text: "Done" } }).ok).toBe(true);
    expect(validateCapabilityResult(compiled, query, { data: { outcome: "pending" }, receipt: { text: "Done" } }).ok).toBe(false);
    expect(capabilityResultSchema(z.object({}), { consumer: true }).parse({ data: {}, receipt: { future: true } }).receipt).toBeUndefined();
  });
  test("size counts UTF-8 JSON bytes, with a boundary just below and above 32 KiB", () => {
    const review = reviewFixture();
    review.preview = {
      kind: "page",
      title: "Page",
      body: "é".repeat(10_000),
      format: "plain",
      changes: [
        { change: "added", text: "é".repeat(2000) },
        { change: "added", text: "é".repeat(2000) },
        { change: "added", text: "é".repeat(2000) },
        { change: "added", text: "" },
      ],
    };
    const bytes = new TextEncoder().encode(JSON.stringify(review)).byteLength;
    const last = review.preview.changes![3]!;
    last.text = "x".repeat(CAPABILITY_MAX_REVIEW_BYTES - bytes - 1);
    expect(new TextEncoder().encode(JSON.stringify(review)).byteLength).toBe(CAPABILITY_MAX_REVIEW_BYTES - 1);
    expect(capabilityActionReviewIssues(review, reviewContext)).toEqual([]);
    last.text += "xx";
    expect(capabilityActionReviewIssues(review, reviewContext)).toContain("Review exceeds 32 KiB");
  });
});

describe("policy declarations and mixed manifests", () => {
  const definition = (): CapabilityActionDefinition => ({ ...compileReviewFixture().actions.get("send")!.definition });
  const compile = (action: CapabilityActionDefinition) => compileCapabilities("demo", { protocolVersion: 2, actions: { send: action } });
  test("declaration guards", () => {
    const invalid = [
      { policy: { silent: "you" }, destructive: true },
      { policy: { silent: "you" }, openWorld: true },
      { policy: { ask: "sends" }, idempotency: "none" },
      { policy: { ask: "deletes" }, idempotency: "none" },
      { approval: "rememberable" },
      { review: undefined },
      { policy: { silent: "you", routines: true } },
      { policy: { ask: "sensitive", routines: false } },
      { policy: { silent: "unknown" } },
      { policy: { ask: "unknown" } },
      { policy: { silent: "you", extra: true } },
    ];
    for (const extra of invalid) {
      const action = definition();
      Object.assign(action, extra);
      expect(() => compile(action)).toThrow("Action send");
    }
    expect(() => compile({ ...definition(), policy: { silent: "you", routines: false } })).not.toThrow();
    expect(() => compile({ ...definition(), policy: { ask: "sensitive" }, idempotency: "none" })).not.toThrow();
  });
  test("localized manifests retain their Action policies", () => {
    const compiled = compileReviewFixture();
    const localized = resolveCapabilityManifestPresentation(compiled.manifest, compiled.presentation, "de");
    expect(localized.policies).toEqual(compiled.manifest.policies);
    expect(capabilityActionPolicy(localized, "send")).toEqual({ ask: "sends" });
  });
  test("policy lookup ignores inherited object properties", () => {
    const manifest = compile(definition()).manifest;
    expect(capabilityActionPolicy(manifest, "constructor")).toBeUndefined();
    expect(capabilityActionPolicy(manifest, "send")).toEqual({ ask: "sends" });
  });
  test("derived approval, sorted policies, legacy hash, and an older strict reader", () => {
    const silent = { ...definition(), policy: { silent: "you" } as const };
    const compiled = compileCapabilities("demo", { protocolVersion: 2, actions: { z: definition(), a: silent } });
    expect(Object.keys(compiled.manifest.policies ?? {})).toEqual(["a", "z"]);
    expect(compiled.manifest.actions.map((action) => action.approval)).toEqual(["rememberable", undefined]);
    for (const action of compiled.manifest.actions) expect(CapabilityActionManifestSchema.safeParse(action).success).toBe(true);
    const { policy: _, ...legacy } = silent;
    const old = compile({ ...legacy, approval: "rememberable" });
    expect(Object.hasOwn(old.manifest, "policies")).toBe(false);
    const { manifestHash, ...base } = old.manifest;
    expect(manifestHash).toBe(capabilityHash(base));
  });
  test("readers drop only unreadable or inconsistent Actions and unknown policy IDs", () => {
    const source = compileCapabilities("demo", { protocolVersion: 2, actions: { a: definition(), b: definition() } }).manifest;
    for (const policy of [{ ask: "future" }, { silent: "you" }, { ask: "sends", extra: true }]) {
      const raw = { ...source, policies: { a: policy, b: { ask: "sends" }, missing: { ask: "sends" } } };
      const { manifestHash: _, ...base } = raw;
      const parsed = parseCapabilityManifest({ ...base, manifestHash: capabilityHash(base) }, "demo");
      expect(parsed.actions.map((a) => a.localId)).toEqual(["b"]);
      expect(parsed.policies).toEqual({ b: { ask: "sends" } });
    }
    expect(
      CapabilityManifestSchema.parse({ ...source, actions: source.actions.map((a) => ({ ...a, review: undefined })) }).actions,
    ).toEqual([]);
  });
  test("one-time approval to policy evolution", () => {
    for (const approval of ["rememberable", undefined] as const)
      for (const policy of [{ silent: "you" }, { ask: "involves_people" }] satisfies CapabilityActionPolicy[]) {
        if (!approval && "silent" in policy) continue;
        const { policy: _, ...legacy } = definition();
        expect(
          capabilityManifestEvolutionIssues(compile({ ...legacy, approval }).manifest, compile({ ...definition(), policy }).manifest),
        ).toEqual([]);
      }
  });
});

describe("review helpers", () => {
  test("dispatch preserves branch errors and approval API output remains projectable", () => {
    for (const review of [{ sentence: {} }, { message: 42 }]) {
      const parsed = CapabilityActionReviewDataSchema.safeParse(review);
      expect(parsed.success).toBe(false);
      if (!parsed.success) expect(parsed.error.issues.every((issue) => issue.code !== "invalid_union")).toBe(true);
    }
    expect(() => z.toJSONSchema(ApprovalPageSchema, { io: "output" })).not.toThrow();
  });
  test("builder and slot types", () => {
    const forms = {
      locale: "en",
      sentence: {
        action: "Send {subject} to {to}",
        running: "Sending {subject} to {to}",
        done: "Queued {subject} to {to}",
        confirm: "Send",
        decline: "Keep",
      },
    } as const;
    const slots = { subject: { kind: "object", title: "Meeting" }, to: { kind: "person", people: [{ name: "Lea" }] } } satisfies Record<
      string,
      CapabilitySlot
    >;
    expect(actionReview(forms, slots).sentence.action).toBe(forms.sentence.action);
    const compileTimeOnly = () => {
      // @ts-expect-error missing slot
      actionReview(forms, { subject: slots.subject });
      // @ts-expect-error extra slot
      actionReview(forms, { ...slots, other: slots.subject });
      // @ts-expect-error a form cannot introduce a slot absent from action
      actionReview({ ...forms, sentence: { ...forms.sentence, done: "Sent {other}" } }, slots);
    };
    void compileTimeOnly;
    const dynamicDone: string = forms.sentence.done;
    expect(actionReview({ ...forms, sentence: { ...forms.sentence, done: dynamicDone } }, slots).slots).toEqual(slots);
    const dynamic: string = "{invalid.path}";
    expect(() => actionReview({ ...forms, sentence: { ...forms.sentence, action: dynamic } }, slots)).toThrow();
  });
  test("assertion and localized catalog checks", () => {
    const review = reviewFixture();
    expect(() => assertCapabilityReview(review)).not.toThrow();
    expect(() => assertCapabilityReview({ ...review, locale: "bad_locale" })).toThrow("locale");
    expect(() => assertCapabilityReview(review, { ...reviewContext, policy: { silent: "you" }, locales: ["de"] })).toThrow("locale");
    expect(checkActionReviewMessages({ locales: ["en", "de"], forms: () => review, slots: review.slots })).toEqual([]);
    expect(
      checkActionReviewMessages({
        locales: ["en"],
        forms: () => ({
          locale: "en",
          sentence: { action: "x".repeat(80), running: "Working", done: "Done", confirm: "Run", decline: "Skip" },
        }),
        slots: {},
      }),
    ).toEqual(["en: question exceeds 80 visible characters"]);
    const forms = (locale: string) => {
      const result = reviewFixture();
      if (locale === "de") Reflect.deleteProperty(result.sentence, "done");
      return result;
    };
    expect(checkActionReviewMessages({ locales: ["en", "de"], forms, slots: review.slots }).join()).toContain("de sentence.done");
  });
  for (const locale of ["en", "de"])
    test(`full legacy view ${locale}`, () => {
      const review = reviewFixture();
      review.locale = locale;
      review.ask = "sends";
      review.preview = {
        kind: "message",
        from: { name: "Ops", address: "ops@example.com" },
        to: Array.from({ length: 50 }, (_, i) => ({ name: `To ${i}`, address: `to${i}@example.com` })),
        cc: [{ name: "Cc", address: "cc@example.com" }],
        bcc: [{ name: "Bcc", address: "bcc@example.com" }],
        more: { bcc: 3 },
        subject: "Meeting",
        body: "Text",
        format: "plain",
        attachments: [{ name: "meeting.pdf" }, { name: "notes.txt" }],
        moreAttachments: 2,
        sendAt: "2026-10-17T12:00:00Z",
      };
      const view = capabilityReviewView(review, { timeZone: "UTC" });
      const text = JSON.stringify(view);
      for (const value of [
        "Ops <ops@example.com>",
        "To 49 <to49@example.com>",
        "Cc <cc@example.com>",
        "Bcc <bcc@example.com>",
        "meeting.pdf",
        "notes.txt",
      ])
        expect(text).toContain(value);
      expect(view.details?.some((detail) => detail.label === "Why" || detail.label === "Warum")).toBe(false);
      const { ask: _ask, ...withoutAsk } = review;
      expect(capabilityReviewView(withoutAsk, { timeZone: "UTC" })).toEqual(view);
      expect(view.details?.find((d) => d.format === "date-time")?.value).toBe("2026-10-17T12:00:00Z");
      const legacy = { message: "Legacy" };
      expect(capabilityReviewView(legacy, { timeZone: "UTC" })).toBe(legacy);
    });
});
