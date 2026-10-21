import { describe, expect, test } from "bun:test";
import { assertCapabilityReview, checkActionReviewMessages, compileCapabilityManifest } from "@k2b/cloud/capabilities/testing";
import {
  CapabilityActionCheckSchema,
  CapabilityActionReceiptSchema,
  type CapabilitySlot,
  capabilityActionPolicy,
} from "@k2b/cloud/contracts";
import { mailCapabilities } from "./capabilities";
import { type MailReviewMessage, mailReviewMessages } from "./capability-review-messages";
import {
  batchReceipt,
  buildMailReview,
  buildSendReview,
  draftPreview,
  draftReviewContent,
  folderDisplayReceipt,
  mailActionReviews,
  mailReceipt,
  reviewCount,
  reviewFieldRows,
  reviewObject,
  reviewPeople,
  reviewPlace,
  reviewTime,
  type SendReviewSource,
  sendReceipt,
} from "./capability-reviews";
import { draftSendOutcome } from "./service/capability-review-readers";

export const sendSource: SendReviewSource = {
  contentHash: "a".repeat(64),
  draft: {
    subject: "Update",
    body: "Hello Lea,\nThe maintenance window is confirmed.\n\nValentin",
    format: "plain",
    to: [{ name: "Lea Berg", address: "lea@example.com" }],
    cc: [{ name: "Mira", address: "mira@example.com" }],
    bcc: [{ name: "Tom", address: "tom@example.com" }],
    attachments: [
      { filename: "plan.pdf", byteLength: 84000 },
      { filename: "calendar.ics", byteLength: 128 },
    ],
  },
  from: { name: "Valentin", address: "valentin@example.com" },
  mailboxId: "MbA123",
  draftId: "DrA123",
  expectedRevision: 7,
  href: "/app/mail/MbA123/drafts/DrA123",
  warnings: [{ title: "1 external recipient", description: "This email leaves the internal domains set for the mailbox." }],
};
const manifest = compileCapabilityManifest("mail", mailCapabilities);
const reviewContext = {
  policy: capabilityActionPolicy(manifest, "draft.send"),
  queries: manifest.queries,
  locales: ["en", "de"],
  validateQueryInput: (query: { localId: string }, input: Record<string, unknown>) =>
    query.localId === "draft.send.check" && mailCapabilities.queries["draft.send.check"].input.safeParse(input).success,
};
const askPolicies = {
  "draft.discard": "deletes",
  "draft.attachment.remove": "deletes",
  "draft.send": "sends",
  "delivery.cancel": "cannot_undo",
  "conversation.keep.release": "cannot_undo",
  "conversation.comment.update": "cannot_undo",
  "conversation.comment.delete": "deletes",
  "mailbox.tag.delete": "deletes",
  "mailing-list.unsubscribe": "sends",
} as const;
const silent = [
  "draft.create",
  "draft.patch",
  "draft.update",
  "draft.attachment.add",
  "conversation.mark",
  "conversation.move",
  "conversation.tag.update",
  "conversation.status.update",
  "conversation.status.update.batch",
  "conversation.keep",
  "conversation.snooze",
  "conversation.comment.create",
  "mailbox.tag.create",
  "mailbox.tag.update",
  "conversation.assign",
  "conversation.assign.batch",
];

describe("Mail review contract", () => {
  test("all 28 policies compile exactly as decided, without legacy approval declarations", () => {
    const expected: Record<string, import("@k2b/cloud/contracts").CapabilityActionPolicy> = {
      ...Object.fromEntries(silent.map((id) => [id, { silent: "shared" }])),
      ...Object.fromEntries(Object.entries(askPolicies).map(([id, ask]) => [id, { ask }])),
      "conversation.reminder.set": { silent: "you" },
      "conversation.reminder.cancel": { silent: "you" },
      "folder.display.set": { silent: "shared", routines: false },
    };
    expect(Object.keys(expected)).toHaveLength(28);
    expect(Object.keys(mailActionReviews).sort()).toEqual(Object.keys(expected).sort());
    expect(Object.keys(mailCapabilities.actions).sort()).toEqual(Object.keys(expected).sort());
    for (const [id, policy] of Object.entries(expected)) expect(capabilityActionPolicy(manifest, id)).toEqual(policy);
    for (const action of Object.values(mailCapabilities.actions)) expect(action).not.toHaveProperty("approval");
    expect(mailCapabilities.queries["draft.send.check"].data).toBe(CapabilityActionCheckSchema);
    expect(() => assertCapabilityReview(buildSendReview(sendSource, "en"), reviewContext)).not.toThrow();
  });

  const representative: Record<string, CapabilitySlot> = {
    draft: reviewObject("Update"),
    subject: reviewObject("Maintenance window Tuesday"),
    conversation: reviewObject("Release"),
    file: reviewObject("plan.pdf"),
    tag: reviewObject("#kunde"),
    comment: reviewObject("Note"),
    delivery: reviewObject("Update"),
    list: reviewObject("News"),
    folder: reviewPlace("Rechnungen", undefined, "ti ti-folder"),
    mailbox: reviewPlace("Team Ops"),
    people: reviewPeople([{ name: "Lea Berg", address: "lea@example.com" }]),
    to: reviewPeople([{ name: "Lea Berg", address: "lea@example.com" }]),
    at: reviewTime("2026-10-20T06:00:00.000Z"),
    count: reviewCount(3),
  };
  const slotsFor = (key: MailReviewMessage, worst = false): Record<string, CapabilitySlot> =>
    Object.fromEntries(
      [...mailReviewMessages("en")[key].action.matchAll(/\{(\w+)\}/g)].map(([, name]) => {
        const slot = representative[name!]!;
        return [
          name!,
          worst && (slot.kind === "object" || slot.kind === "place")
            ? { ...slot, title: "界".repeat(200) }
            : worst && slot.kind === "person"
              ? reviewPeople(Array.from({ length: 60 }, (_, i) => ({ name: "界".repeat(200), address: `person${i}@example.com` })))
              : slot,
        ];
      }),
    );
  for (const key of Object.keys(mailReviewMessages("en")) as MailReviewMessage[]) {
    test(`${key}: both locale catalogs and every form are valid`, () => {
      expect(
        checkActionReviewMessages({
          locales: ["de", "en"],
          forms: (locale) => ({ locale, sentence: mailReviewMessages(locale)[key] }),
          slots: slotsFor(key),
        }),
      ).toEqual([]);
      for (const locale of ["de", "en"]) {
        const review = buildMailReview(key, locale, slotsFor(key, true));
        if (key in askPolicies) expect(review.ask).toBe(askPolicies[key as keyof typeof askPolicies]);
        expect(() => assertCapabilityReview(review)).not.toThrow();
        expect(CapabilityActionReceiptSchema.safeParse(mailReceipt(key, locale, slotsFor(key, true))).success).toBeTrue();
      }
    });
  }
  test("catalog checker catches a missing form and an overlong question", () => {
    const { running: _running, ...missing } = mailReviewMessages("en")["draft.create"];
    // Deliberately invalid runtime catalog: test the public guard, not TypeScript.
    expect(
      checkActionReviewMessages({
        locales: ["en"],
        slots: { draft: reviewObject("Update") },
        forms: () => JSON.parse(JSON.stringify({ locale: "en", sentence: missing })),
      }),
    ).not.toEqual([]);
    expect(
      checkActionReviewMessages({
        locales: ["en"],
        slots: { draft: reviewObject("Update") },
        forms: () => ({
          locale: "en",
          sentence: { ...mailReviewMessages("en")["draft.create"], action: `Create the draft {draft} ${"long ".repeat(20)}` },
        }),
      }),
    ).toContain("en: question exceeds 80 visible characters");
  });
  test("send completeness is checked with declaration context", () => {
    const review = buildSendReview(sendSource, "de");
    assertCapabilityReview(review, reviewContext);
    if (review.preview?.kind !== "message") throw new Error("Expected message");
    const missingFrom = structuredClone(review);
    if (missingFrom.preview?.kind === "message") delete missingFrom.preview.from;
    expect(() => assertCapabilityReview(missingFrom, reviewContext)).toThrow("requires from");
    for (const field of ["bcc", "attachments", "body"] as const) {
      const incomplete = structuredClone(review);
      delete incomplete.links;
      delete incomplete.content;
      if (incomplete.preview?.kind !== "message") throw new Error("Expected message");
      if (field === "bcc") incomplete.preview.more = { bcc: 1 };
      if (field === "attachments") incomplete.preview.moreAttachments = 1;
      if (field === "body") incomplete.preview.truncated = true;
      expect(() => assertCapabilityReview(incomplete, reviewContext)).toThrow("open link");
    }
  });
  test("the reviewed revision changes the serialized approval input", () => {
    const seven = buildSendReview(sendSource, "en");
    const eight = buildSendReview({ ...sendSource, expectedRevision: 8 }, "en");
    expect(JSON.stringify(seven)).not.toBe(JSON.stringify(eight));
    expect(eight.check?.input.expectedRevision).toBe(8);
    expect(eight.links?.[0]?.href).toBe(sendSource.href);
  });
  test("valid worst-case Mail content fits the whole review and retains overflow counts", () => {
    for (const locale of ["en", "de"]) {
      const people = Array.from({ length: 60 }, (_, i) => ({ name: "界".repeat(200), address: `p${i}@example.com` }));
      const draft = {
        ...sendSource.draft,
        subject: "界".repeat(998),
        body: "界".repeat(20_000),
        to: people,
        cc: people,
        bcc: people,
        attachments: Array.from({ length: 60 }, (_, i) => ({ filename: `${i}${"界".repeat(245)}.pdf`, byteLength: i })),
      };
      const source = { ...sendSource, draft, from: { ...sendSource.from, name: "界".repeat(200) } };
      for (const scheduledAt of [undefined, "2026-10-20T06:00:00.000Z"]) {
        const review = buildSendReview({ ...source, scheduledAt }, locale);
        assertCapabilityReview(review, reviewContext);
        const { content, ...compact } = review;
        expect(content?.body).toBe(draft.body);
        expect(Buffer.byteLength(JSON.stringify(compact))).toBeLessThanOrEqual(32768);
        if (review.preview?.kind !== "message") throw new Error("Expected message");
        for (const role of ["to", "cc", "bcc"] as const)
          expect((review.preview[role]?.length ?? 0) + (review.preview.more?.[role] ?? 0)).toBe(60);
        expect((review.preview.attachments?.length ?? 0) + (review.preview.moreAttachments ?? 0)).toBe(60);
        expect(review.preview.truncated).toBeTrue();
      }
      for (const message of ["draft.create", "draft.patch", "draft.update", "draft.discard"] as const)
        assertCapabilityReview(
          buildMailReview(
            message,
            locale,
            { draft: reviewObject(draft.subject) },
            { preview: draftPreview(draft, locale), links: [{ rel: "open", href: sendSource.href }] },
          ),
        );
    }
  });
  test("builders resolve variants from real call arguments and use a single fallback locale", () => {
    const conversation = { conversation: reviewObject("Release") };
    const count = { count: reviewCount(3) };
    for (const locale of ["en", "de"]) {
      for (const [read, flagged] of [
        [true, undefined],
        [false, undefined],
        [undefined, true],
        [undefined, false],
        [true, true],
        [true, false],
        [false, true],
        [false, false],
      ] as const)
        assertCapabilityReview(mailActionReviews["conversation.mark"](read, flagged, locale, conversation));
      for (const mode of ["add", "remove", "replace"] as const) {
        assertCapabilityReview(
          mailActionReviews["conversation.assign"](
            mode,
            locale,
            { ...conversation, people: representative.people! },
            { ask: "involves_people" },
          ),
        );
        assertCapabilityReview(
          mailActionReviews["conversation.assign.batch"](
            mode,
            locale,
            { ...count, people: representative.people! },
            { ask: "changes_access", effects: 3 },
          ),
        );
      }
      for (const batch of [false, true]) {
        const people = reviewPeople([]);
        const review = batch
          ? mailActionReviews["conversation.assign.batch"]("replace", locale, { ...count, people }, { ask: "changes_access" })
          : mailActionReviews["conversation.assign"]("replace", locale, { ...conversation, people }, { ask: "changes_access" });
        assertCapabilityReview(review);
        expect(review.sentence.confirm).toBe(locale === "de" ? "Zuweisung aufheben" : "Unassign");
        expect(review.slots).not.toHaveProperty("people");
      }
      for (const display of ["everywhere", "folder_only", "hidden"] as const)
        assertCapabilityReview(mailActionReviews["folder.display.set"](display, locale, { folder: representative.folder! }));
      for (const status of ["done", "open"] as const) {
        assertCapabilityReview(mailActionReviews["conversation.status.update"](status, locale, conversation));
        assertCapabilityReview(mailActionReviews["conversation.status.update.batch"](status, locale, count, { effects: 3 }));
      }
      for (const until of [undefined, "2026-10-20T06:00:00.000Z"])
        assertCapabilityReview(
          mailActionReviews["conversation.snooze"](until, locale, { ...conversation, ...(until ? { at: reviewTime(until) } : {}) }),
        );
    }
    expect(mailActionReviews["draft.discard"]("de-DE", { draft: reviewObject("Update") }).locale).toBe("de");
    expect(mailActionReviews["draft.discard"]("fr-FR", { draft: reviewObject("Update") }).locale).toBe("en");
  });
  test("worst-case assignment audiences fit without changing their counts or loaded data", () => {
    const people = Array.from({ length: 20 }, (_, i) => ({ name: "界".repeat(200), address: `${i}${"a".repeat(300)}@example.test` }));
    const options = {
      ask: "involves_people" as const,
      effects: 50,
      consequences: [
        { text: "{people} will be notified.", slots: { people: { kind: "person" as const, people, total: 20 } } },
        { text: "{people} will lose access.", slots: { people: { kind: "person" as const, people, total: 1000 } } },
      ],
    };
    const original = JSON.stringify(options);
    for (const locale of ["en", "de"]) {
      const review = mailActionReviews["conversation.assign.batch"](
        "replace",
        locale,
        { count: reviewCount(50, locale), people: reviewPeople(people) },
        options,
      );
      assertCapabilityReview(review, { ...reviewContext, policy: capabilityActionPolicy(manifest, "conversation.assign.batch") });
      expect(Buffer.byteLength(JSON.stringify(review))).toBeLessThanOrEqual(32768);
      expect(review.consequences?.map((c) => c.slots?.people?.kind === "person" && c.slots.people.total)).toEqual([20, 1000]);
    }
    expect(JSON.stringify(options)).toBe(original);
  });
  test("the unsubscribe preview retains long List-IDs and endpoint tails", () => {
    const address = "界".repeat(4096);
    const href = "https://example.test/" + "a".repeat(2027);
    for (const locale of ["en", "de"]) {
      const rows = [...reviewFieldRows("Endpoint", href), ...reviewFieldRows("Address", address)];
      const review = mailActionReviews["mailing-list.unsubscribe"](
        locale,
        { list: reviewObject("界".repeat(4096)) },
        { preview: { kind: "fields", rows } },
      );
      assertCapabilityReview(review, { ...reviewContext, policy: capabilityActionPolicy(manifest, "mailing-list.unsubscribe") });
      expect(rows.map((row) => row.value).join("")).toBe(href + address);
    }
  });
  test("folder receipts preserve inherited restrictions instead of promising visibility", () => {
    for (const locale of ["en", "de"]) {
      const receipt = folderDisplayReceipt("hidden", reviewPlace("Child"), reviewPlace("Parent"), locale);
      expect(CapabilityActionReceiptSchema.safeParse(receipt).success).toBeTrue();
      expect(receipt.text).toContain("{parent}");
      expect(receipt.text).not.toMatch(/everywhere|überall/);
      expect(folderDisplayReceipt("hidden", reviewPlace("Child"), undefined, locale).text).toMatch(/hidden|ausgeblendet/i);
    }
  });
  test("recipient-free drafts have page previews; Cc/Bcc-only sends name real recipients", () => {
    expect(draftPreview({ ...sendSource.draft, to: [], cc: [], bcc: [] }).kind).toBe("page");
    for (const cc of [sendSource.draft.cc, []]) {
      const review = buildSendReview({ ...sendSource, draft: { ...sendSource.draft, to: [], cc } });
      expect(review.slots.to).toMatchObject({ people: cc.length ? cc : sendSource.draft.bcc });
    }
  });
  test("message previews omit empty optional lists and zero overflow counts", () => {
    const preview = draftPreview({ ...sendSource.draft, cc: [], bcc: [], attachments: [] });
    expect(preview.kind).toBe("message");
    for (const key of ["cc", "bcc", "attachments", "more", "moreAttachments"]) expect(preview).not.toHaveProperty(key);
    const overflow = draftPreview({ ...sendSource.draft, to: Array.from({ length: 51 }, () => sendSource.draft.to[0]!) });
    expect(overflow.kind === "message" && overflow.more).toEqual({ to: 1 });
  });
  test("warning leads preserve punctuation, including combined overflow warnings", () => {
    for (const punctuation of [".", "!", "?", "…", ":", ";"]) {
      const title = "External recipient" + punctuation;
      const review = buildSendReview({ ...sendSource, warnings: Array.from({ length: 6 }, () => ({ title, description: "Details." })) });
      if (review.preview?.kind !== "message") throw new Error("Expected message");
      expect(review.preview.warnings?.[0]).toBe(title + " Details.");
      expect(review.preview.warnings?.[4]).toBe(title + " " + title);
    }
  });
  test("all safety warning kinds remain visible; done and receipts never claim completed delivery", () => {
    const warnings = Array.from({ length: 6 }, (_, i) => ({ title: `Kind ${i}`, description: `Details ${i}.` }));
    const review = buildSendReview({ ...sendSource, warnings });
    expect(review.preview?.kind === "message" && review.preview.warnings).toHaveLength(5);
    expect(JSON.stringify(review.preview)).toContain("Kind 5");
    for (const locale of ["de", "en"])
      for (const scheduledAt of [undefined, "2026-10-20T06:00:00.000Z"]) {
        const review = buildSendReview({ ...sendSource, scheduledAt }, locale);
        const receipt = sendReceipt(sendSource.draft, sendSource.draftId, scheduledAt, locale);
        for (const text of [review.sentence.done, receipt.text]) {
          expect(text).not.toMatch(/(?<!wird )gesendet\.|(?<!being) sent\./);
          expect(text).toContain(
            scheduledAt ? (locale === "de" ? "geplant für" : "scheduled for") : locale === "de" ? "wird gesendet" : "is being sent",
          );
        }
      }
  });
  test("deletions lose their ref and partial batches name the missing part", () => {
    const receipt = mailReceipt("draft.discard", "de", { draft: reviewObject("Update", { type: "mail.draft", id: "DrA123" }) }, "draft");
    expect(receipt.slots?.draft).toMatchObject({ gone: true });
    expect(receipt.slots?.draft).not.toHaveProperty("ref");
    expect(batchReceipt("conversation.status.update.batch.done", 3, 4, "de").text).toContain("1 fehlen");
  });
  test("every delivery state maps explicitly to the check contract", () => {
    for (const state of ["scheduled", "undo_window", "sending", "accepted", "sent_sync_pending", "sent", "reconciled_accepted"] as const)
      expect(draftSendOutcome(state)).toBe("done");
    for (const state of ["failed", "cancelled", "reconciled_unsent", undefined] as const) expect(draftSendOutcome(state)).toBe("not_done");
    for (const state of ["unknown", "needs_attention"] as const) expect(draftSendOutcome(state)).toBe("pending");
  });
  test("query interaction hints preserve the declared external and local boundaries", () => {
    for (const id of [
      "search",
      "conversation.list",
      "conversation.focus",
      "conversation.search",
      "conversation.related",
      "conversation.read",
      "message.list",
      "message.read-content",
      "message.read",
    ] as const)
      expect(mailCapabilities.queries[id].openWorld).toBeTrue();
    // A permission-scoped local lookup is closed-world; its content remains untrusted.
    for (const id of ["attachment.read-content", "draft.read", "draft.list"] as const)
      expect(mailCapabilities.queries[id].openWorld).toBeFalse();
  });
});

test("full draft proposal preserves source, base revision, 600 recipients and 202 MIME descriptions", () => {
  const people = Array.from({ length: 200 }, (_, i) => ({ name: `Person ${i}\u202e`, address: `person${i}@example.test` }));
  const draft = {
    ...sendSource.draft,
    revision: 7,
    body: `${"x".repeat(80_000)}UNSAVED\u0000`,
    to: people,
    cc: people,
    bcc: people,
    attachments: Array.from({ length: 202 }, (_, i) => ({ filename: `file-${i}\u202e.txt`, byteLength: i })),
  };
  const content = draftReviewContent(draft);
  expect(content.body).toBe(draft.body);
  expect(content.baseRevision).toBe(7);
  expect(content.to).toEqual(people);
  expect(content.cc).toEqual(people);
  expect(content.bcc).toEqual(people);
  expect(content.attachments).toHaveLength(202);
  expect(content.attachments?.at(-1)).toEqual({ name: "file-201\u202e.txt", size: 201 });
  const review = buildSendReview({
    ...sendSource,
    draft,
    from: { name: "Sender\u202e", address: "sender@example.test" },
    warnings: [{ title: "Warning\u202e", description: "Complete description" }],
  });
  assertCapabilityReview(review, reviewContext);
  expect(review.content).toMatchObject({
    ...content,
    from: { name: "Sender\u202e", address: "sender@example.test" },
    warnings: ["Warning\u202e. Complete description"],
  });
});

test("compact Mail excerpts preserve Unicode boundaries without changing the full proposal", () => {
  const source = { ...sendSource.draft, body: "x".repeat(9_999) + "😀tail\ud800" };
  const preview = draftPreview(source);
  if (preview.kind !== "message") throw new Error("Expected message preview");
  expect(preview.body.isWellFormed()).toBe(true);
  expect(preview.body).toBe("x".repeat(9_999));
  expect(preview.truncated).toBe(true);
  expect(draftReviewContent(source).body).toBe(source.body);
  const title = reviewObject("x".repeat(199) + "😀tail");
  if (title.kind !== "object") throw new Error("Expected object slot");
  expect(title.title).toBe("x".repeat(199));
  const target = "x".repeat(1_999) + "😀tail";
  const rows = reviewFieldRows("Target", target);
  expect(rows.map((row) => row.value).join("")).toBe(target);
  expect(rows.every((row) => row.value.isWellFormed() && row.value.length <= 2_000)).toBe(true);
});
