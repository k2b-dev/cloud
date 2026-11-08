import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { assertCapabilityReview, checkActionReviewMessages } from "../capabilities/testing";
import { ApprovalPageSchema } from "../contracts/approvals";
import {
  CapabilityActionCallReviewSchema,
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
import {
  byteBoundaryReview,
  compileReviewFixture,
  outcomeCheckCases,
  receiptCases,
  reviewCases,
  reviewFixture,
} from "./capability-review.test-fixture";
import { actionReview, capabilityActionReviewIssues, capabilityReviewRememberScope, capabilityReviewView } from "./capability-reviews";
import { capabilityReviewSentence } from "./capability-sentences";

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
  for (const { name, result: wire, valid } of outcomeCheckCases())
    test(`producer outcome check: ${name}`, () => {
      const compiled = compileReviewFixture();
      const result = validateCapabilityResult(compiled, compiled.queries.get("check")!, wire);
      expect(result.ok).toBe(valid);
      if (valid && result.ok) expect(result.data).toEqual(wire);
      else expect(result).toMatchObject({ ok: false, error: { code: "INVALID_APP_RESPONSE", status: 500 } });
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
  test("a sends Draft requires sender context even with a different per-call reason", () => {
    const review = {
      ...reviewFixture(),
      view: {
        version: 1 as const,
        blocks: [{ kind: "Draft" as const, fields: [{ name: "body", label: "Body", type: "textarea" as const, value: "Text" }] }],
      },
    };
    const ctx = { ...reviewContext, inputSchema: { properties: { body: { type: "string" } } } };
    for (const ask of [undefined, "involves_people", "sends"] as const)
      expect(capabilityActionReviewIssues({ ...review, ask }, ctx)).toContain("A sends Draft requires sender context (From/Von)");
    expect(
      capabilityActionReviewIssues(
        {
          ...review,
          view: { version: 1, blocks: [{ ...review.view.blocks[0]!, context: [{ label: "From", value: "ops@example.com" }] }] },
        },
        ctx,
      ),
    ).toEqual([]);
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
      expect(validateCapabilityResult(compiled, action, { data: {}, receipt, links: [{ rel: "open", href: "/app/demo" }] }).ok).toBe(false);
    }
    expect(validateCapabilityResult(compiled, action, { data: {}, receipt: { text: "Done" } }).ok).toBe(true);
    expect(validateCapabilityResult(compiled, query, { data: { outcome: "pending" }, receipt: { text: "Done" } }).ok).toBe(false);
    expect(capabilityResultSchema(z.object({}), { consumer: true }).parse({ data: {}, receipt: { future: true } }).receipt).toBeUndefined();
  });
  test("metadata counts UTF-8 JSON bytes on either side of 32 KiB", () => {
    const compiled = compileReviewFixture();
    const ctx = { ...reviewContext, queries: compiled.manifest.queries, validateQueryInput: () => true };
    expect(capabilityActionReviewIssues(byteBoundaryReview(false), ctx)).toEqual([]);
    expect(capabilityActionReviewIssues(byteBoundaryReview(true), ctx)).toContain("Review exceeds 32 KiB");
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
  test("readers reject unreadable policy containers", () => {
    const source = compile({ ...definition(), policy: { silent: "you", routines: false } }).manifest;
    for (const policies of [null, [], "unreadable", 42]) {
      const { manifestHash: _, ...base } = { ...source, policies };
      const raw = { ...base, manifestHash: capabilityHash(base) };
      expect(CapabilityManifestSchema.safeParse(raw).success).toBe(false);
      expect(() => parseCapabilityManifest(raw, "demo")).toThrow();
    }
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
  test("schema and builder accept explicitly undefined optional forms", () => {
    for (const form of ["rejected", "notRun", "short"]) {
      const review = reviewFixture();
      const forms = { locale: review.locale, sentence: { ...review.sentence, [form]: undefined } };
      expect(CapabilityActionCallReviewSchema.safeParse({ ...review, ...forms }).success).toBe(true);
      expect(actionReview(forms, review.slots).sentence).toEqual(forms.sentence);
    }
  });
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
  test("a long person name fits a button and a mail display name fits a person", () => {
    // A valid recipient must never make the question itself invalid: buttons cut one person's name like an object title.
    const name = `Lea ${"Berg-".repeat(38)}Ende-x`;
    expect(name.length).toBe(200);
    const review = actionReview(
      {
        locale: "de",
        sentence: {
          action: "Mail {subject} an {to} senden",
          running: "Mail {subject} an {to} wird gesendet …",
          done: "Mail {subject} an {to} wird gesendet.",
          confirm: "An {to} senden",
          decline: "Nicht an {to} senden",
        },
      },
      { subject: { kind: "object", title: "Wartungsfenster" }, to: { kind: "person", people: [{ name, address: "lea@example.com" }] } },
    );
    expect(capabilityReviewSentence(review, "confirm", { timeZone: "UTC" })).toBe("An Lea Berg-Ber…Berg-Ende-x senden");
    expect(Array.from(capabilityReviewSentence(review, "decline", { timeZone: "UTC" })).length).toBeLessThanOrEqual(40);
    expect(() =>
      actionReview({ ...review, sentence: review.sentence }, { ...review.slots, to: { kind: "person", people: [{ name: `${name}x` }] } }),
    ).toThrow();
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
  test("deprecated literal reviews retain their projection", () => {
    const legacy = { message: "Legacy" };
    expect(capabilityReviewView(legacy, { timeZone: "UTC" })).toBe(legacy);
  });
});
