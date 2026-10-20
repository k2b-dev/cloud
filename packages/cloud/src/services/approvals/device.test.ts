import { expect, test } from "bun:test";
import { actionCardText } from "../../ai/chat/action-text";
import { assertCapabilityReview } from "../../capabilities/testing";
import {
  APP_ACTION_LIMITS,
  APP_APPROVAL_LIMITS,
  AppActionSummarySchema,
  AppActionViewSchema,
  appActionDigest,
} from "../../contracts/app-approval";
import type { CapabilityActionCallReview } from "../../contracts/capabilities";
import { appNameIn } from "../../ssr/runtime";
import { appActionOffered, appActionSummary, appActionView, pendingApprovalCard } from "./device";
import type { PendingApprovalRow } from "./list";

const row: PendingApprovalRow = {
  id: "ab811792-7476-4a8c-b676-2c6007bb9b5b",
  appId: "mail",
  action: "draft.send",
  argsDigest: "stored-args-digest",
  requesterAppId: "assistant",
  assurance: "confirm",
  sentence: "Mail: Send draft",
  details: null,
  storedReview: null,
  createdAt: new Date("2026-10-11T10:00:00Z"),
  expiresAt: new Date("2026-10-12T10:00:00Z"),
  cursorCreatedAt: "2026-10-11T10:00:00.000000Z",
  conversationShortId: "abcdef1234",
  conversationTitle: "A letter",
  requesterTitle: "A letter",
  allowChat: false,
  allowAlways: false,
  rememberToolName: null,
  toolName: "mail.draft.send",
  runConfig: null,
};
const options = { issuer: "https://cloud.example", appName: (id: string) => (id === "mail" ? "Mail" : "Assistant") };

const mailReview = (locale = "en"): CapabilityActionCallReview => ({
  locale,
  sentence: {
    action: locale === "de" ? "Mail an {recipient} senden" : "Send mail to {recipient}",
    running: locale === "de" ? "Mail an {recipient} wird gesendet" : "Sending mail to {recipient}",
    done: locale === "de" ? "Mail an {recipient} gesendet" : "Sent mail to {recipient}",
    confirm: locale === "de" ? "An Lea senden" : "Send to Lea",
    decline: locale === "de" ? "Nicht senden" : "Don't send",
  },
  slots: { recipient: { kind: "person", people: [{ name: "Lea Berg", address: "lea.berg@example.com" }] } },
  ask: "sends",
  links: [{ rel: "open", href: "/mail/drafts/maintenance?revision=7" }],
  preview: {
    kind: "message",
    from: { name: "Team Ops", address: "ops@example.com" },
    to: [{ name: "Lea Berg", address: "lea.berg@example.com" }],
    cc: [{ name: "Ada", address: "ada@example.com" }],
    subject: "Wartungsfenster Dienstag",
    attachments: [{ name: "wartung.pdf", size: 84_000 }],
    body: "Hallo Lea,\ndas Wartungsfenster ist am Dienstag.",
    format: "plain",
  },
});

test("no-review questions use the card's question, reason and later sentence rows with terminal controls cleaned", async () => {
  const input = { ...row, sentence: "Mail: Send draft\nTo: Ada\u0000 Lovelace", requesterTitle: " A\u2029letter\u2066 " };
  const view = await appActionView(input, options);
  expect(view.sentence).toBe("Send draft?");
  expect(view.requester.title).toBe("A letter");
  expect(view.message).toBe(pendingApprovalCard(input, options.appName).reason.text);
  expect(view.details).toEqual([{ label: "To", value: "Ada Lovelace" }]);
  expect(view.truncated).toBe(false);
  expect(AppActionViewSchema.parse(view)).toEqual(view);
});

for (const locale of ["de", "en"])
  test(`new message reviews map the same question and digest in ${locale}`, async () => {
    const input = {
      ...row,
      storedReview: mailReview(locale),
      details: { ...mailReview(locale), ask: "app_asks" },
      runConfig: { kind: "chat" as const, input: "Send", locale, timeZone: "Europe/Berlin" },
    };
    assertCapabilityReview(input.storedReview);
    assertCapabilityReview(input.details);
    const card = pendingApprovalCard(input, options.appName);
    const view = await appActionView(input, options);
    expect(view.sentence).toBe(card.questionText);
    expect(view.sentence).toContain("Lea Berg <lea.berg@example.com>");
    expect(view.message).toBe(card.reason.text);
    expect(view.details.map((detail) => detail.label)).toEqual(
      locale === "de" ? ["Von", "An", "Cc", "Betreff", "Anhänge", "Text"] : ["From", "To", "Cc", "Subject", "Attachments", "Text"],
    );
    expect(view.details[0]?.value).toBe("Team Ops <ops@example.com>");
    expect(view.details.at(-1)?.value).toBe("Hallo Lea, das Wartungsfenster ist am Dienstag.");
    expect(view.truncated).toBe(false);
    expect(appActionOffered(view, card)).toBe(true);
    expect(AppActionViewSchema.parse(view)).toEqual(view);
    // This is the same public helper the browser/device uses to recompute the signed cloud-action-v1 digest.
    expect(view.digest).toBe(await appActionDigest(options.issuer, view));
    expect(await appActionView(input, options)).toEqual(view);
  });

test("legacy reviews preserve literal questions, date hints and Markdown blocks through the card", async () => {
  const input = {
    ...row,
    details: {
      message: "Read this letter?",
      details: [
        { label: "Date", value: "2026-10-11", format: "date" },
        { label: "Time", value: "2026-10-11T10:00:00+02:00", format: "date-time" },
        { label: "Body", value: "**Hello**\nworld", format: "markdown", display: "block" },
      ],
    },
  };
  const view = await appActionView(input, options);
  expect(view.sentence).toBe("Read this letter?");
  expect(view.message).toBe(pendingApprovalCard(input, options.appName).reason.text);
  expect(view.details).toEqual([
    { label: "Date", value: "2026-10-11", format: "date" },
    { label: "Time", value: "2026-10-11T10:00:00+02:00", format: "date-time" },
    { label: "Text", value: "**Body** **Hello** world" },
  ]);
});

for (const kind of ["body", "more", "attachments", "rows", "value"] as const)
  test(`truncated sends stay browser-only: ${kind}`, async () => {
    const review = mailReview();
    if (review.preview?.kind !== "message") throw new Error("Expected message fixture");
    if (kind === "body") review.preview.truncated = true;
    if (kind === "more") review.preview.more = { to: 1 };
    if (kind === "attachments") review.preview.moreAttachments = 1;
    if (kind === "rows") review.consequences = Array.from({ length: 3 }, () => ({ text: "Also updates the log" }));
    if (kind === "value") review.preview.body = "x".repeat(APP_ACTION_LIMITS.valueChars + 1);
    assertCapabilityReview(review);
    const input = { ...row, storedReview: review };
    const card = pendingApprovalCard(input, options.appName);
    const view = await appActionView(input, options);
    expect(view.truncated).toBe(true);
    expect(appActionOffered(view, card)).toBe(false);
    expect(appActionOffered(view, actionCardText(card))).toBe(false);
    const other = pendingApprovalCard({ ...input, storedReview: { ...review, ask: "app_asks" } }, options.appName);
    expect(appActionOffered(view, other)).toBe(true);
  });

test("caps code points, rows and response bytes including the digest without changing the protocol", async () => {
  const input = {
    ...row,
    sentence: "😀".repeat(281),
    requesterTitle: "😀".repeat(81),
    details: {
      message: "😀".repeat(281),
      details: Array.from({ length: 9 }, () => ({ label: "😀".repeat(40), value: "😀".repeat(5000) })),
    },
  };
  const names = { ...options, appName: () => "😀".repeat(60) };
  const view = await appActionView(input, names);
  expect(view.truncated).toBe(true);
  expect(Array.from(view.sentence)).toHaveLength(APP_ACTION_LIMITS.sentenceChars);
  expect(view.sentence.endsWith("…")).toBe(true);
  expect(Array.from(appActionSummary(view).sentence)).toHaveLength(APP_ACTION_LIMITS.summaryChars);
  expect(view.details.length).toBeLessThan(8);
  expect(new TextEncoder().encode(JSON.stringify(view)).length).toBeLessThanOrEqual(APP_APPROVAL_LIMITS.bodyBytes);
  expect(AppActionViewSchema.parse(view)).toEqual(view);
  expect(view.digest).toBe(await appActionDigest(options.issuer, view));
  expect(AppActionSummarySchema.parse(appActionSummary(view))).toEqual(appActionSummary(view));
});

test("recorded German app names strip the sentence prefix and keep the digest independent of the phone locale", async () => {
  const runtime = {
    apps: [
      { id: "files", name: "Files", description: "Files", presentation: { baseLocale: "en", translations: { de: { name: "Dateien" } } } },
      {
        id: "assistant",
        name: "Assistant",
        description: "Assistant",
        presentation: { baseLocale: "en", translations: { de: { name: "Assistent" } } },
      },
    ],
  };
  const input = {
    ...row,
    appId: "files",
    sentence: "Dateien: Datei löschen",
    runConfig: { kind: "chat" as const, input: "Löschen", locale: "de" },
  };
  const views = [];
  for (const phoneLocale of ["en", "de"]) {
    const carrier = {
      get: (key: string) => (key === "runtime" ? runtime : undefined),
      req: { raw: { headers: new Headers({ "Accept-Language": phoneLocale }) } },
    };
    const appName = (id: string, locale: string) => appNameIn(carrier, id, locale, id);
    views.push(await appActionView(input, { issuer: options.issuer, appName }));
    const fallback = await appActionView(
      { ...input, runConfig: null, sentence: "Files: Delete file" },
      { issuer: options.issuer, appName },
    );
    expect(fallback.app.name).toBe("Files");
    expect(fallback.sentence).toBe("Delete file?");
  }
  expect(views[0]?.app.name).toBe("Dateien");
  expect(views[0]?.requester.app.name).toBe("Assistent");
  expect(views[0]?.sentence).toBe("Datei löschen?");
  expect(views[0]).toEqual(views[1]);
});

test("fallback questions and legacy rows retain plain-text cleaning and keep unlabelled rows as notes", async () => {
  const fallback = await appActionView({ ...row, sentence: "\n\t", requesterTitle: "\u202e" }, options);
  expect(fallback.requester.title).toBeNull();
  expect(fallback.sentence).toBe(`${row.action}?`);
  expect((await appActionView({ ...row, sentence: "Mail:" }, options)).sentence).toBe("Mail:?");
  const cleaned = await appActionView(
    {
      ...row,
      sentence: "\n Mail: Send\t draft\u202e\nTo: Ada\u0000 Lovelace\nRead\u2028this\u200b first\n",
    },
    options,
  );
  expect(cleaned.sentence).toBe("Send draft ?");
  expect(cleaned.details).toEqual([
    { label: "To", value: "Ada Lovelace" },
    { label: "Note", value: "Read this first" },
  ]);
  expect(cleaned.truncated).toBe(false);
  const review = await appActionView(
    { ...row, details: { message: "Read\nthis\u202e?", details: [{ label: "Body\u202e", value: "Hello\nworld\u200b" }] } },
    options,
  );
  expect(review.sentence).toBe("Read this?");
  expect(review.details).toEqual([{ label: "Body", value: "Hello world" }]);
});

test("all bounded fields cut within their limits and keep the first eight rows in order", async () => {
  const view = await appActionView(
    {
      ...row,
      requesterTitle: "😀".repeat(81),
      details: {
        message: "x".repeat(281),
        details: Array.from({ length: 9 }, (_, index) => ({ label: `${index}${"l".repeat(40)}`, value: "v".repeat(301) })),
      },
    },
    { ...options, appName: () => "a".repeat(501) },
  );
  expect(view.details).toHaveLength(APP_ACTION_LIMITS.details);
  expect(view.details.at(-1)?.label).toBe(`7${"l".repeat(38)}…`);
  expect(Array.from(view.requester.title ?? "")).toHaveLength(APP_ACTION_LIMITS.titleChars);
  expect(Array.from(view.sentence)).toHaveLength(APP_ACTION_LIMITS.sentenceChars);
  expect(Array.from(view.message ?? "")).toHaveLength(APP_ACTION_LIMITS.messageChars);
  expect(
    view.details.every(
      (field) =>
        Array.from(field.label).length === APP_ACTION_LIMITS.labelChars && Array.from(field.value).length === APP_ACTION_LIMITS.valueChars,
    ),
  ).toBe(true);
  expect(view.truncated).toBe(true);
  expect(AppActionViewSchema.parse(view)).toEqual(view);
});
