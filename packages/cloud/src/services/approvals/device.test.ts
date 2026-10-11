import { expect, test } from "bun:test";
import {
  APP_ACTION_LIMITS,
  APP_APPROVAL_LIMITS,
  AppActionSummarySchema,
  AppActionViewSchema,
  appActionDigest,
} from "../../contracts/app-approval";
import { appActionSummary, appActionView } from "./device";
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

test("cleans every text, removes the registry prefix, and separates later sentence lines", async () => {
  const view = await appActionView(
    {
      ...row,
      sentence: "\n  Mail: Send\t draft\u202e\nTo:  Ada\u0000 Lovelace\nRead\u2028this\u200b first\n\n",
      requesterTitle: "  A\u2029letter\u2066  ",
    },
    options,
  );
  expect(view.sentence).toBe("Send draft");
  expect(view.requester.title).toBe("A letter");
  expect(view.message).toBe("Read this first");
  expect(view.details).toEqual([{ label: "To", value: "Ada Lovelace" }]);
  expect(view.truncated).toBe(false);
  expect(AppActionViewSchema.parse(view)).toEqual(view);
  expect((await appActionView({ ...row, sentence: "\n\t", requesterTitle: "\u202e" }, options)).requester.title).toBeNull();
  expect((await appActionView({ ...row, sentence: "\n\t" }, options)).sentence).toBe(row.action);
  expect((await appActionView({ ...row, sentence: "Mail:" }, options)).sentence).toBe("Mail:");
});

test("a valid review owns the message and details, preserving date formats and treating markdown as text", async () => {
  const view = await appActionView(
    {
      ...row,
      sentence: "Mail: Send draft\nIgnored: field",
      details: {
        message: "Send draft",
        details: [
          { label: "Date", value: "2026-10-11", format: "date" },
          { label: "Time", value: "2026-10-11T10:00:00+02:00", format: "date-time" },
          { label: "Body\u202e", value: "**Hello**\n[link](https://example.test)", display: "block", format: "markdown" },
        ],
      },
    },
    options,
  );
  expect(view.message).toBeNull();
  expect(view.details).toEqual([
    { label: "Date", value: "2026-10-11", format: "date" },
    { label: "Time", value: "2026-10-11T10:00:00+02:00", format: "date-time" },
    { label: "Body", value: "**Hello** [link](https://example.test)" },
  ]);
  expect((await appActionView({ ...row, details: { message: " Explain\nwhy\u202e " } }, options)).message).toBe("Explain why");
});

test("caps details in order and cuts text by code points with an ellipsis inside each limit", async () => {
  const view = await appActionView(
    {
      ...row,
      details: { message: "😀".repeat(501), details: Array.from({ length: 9 }, (_, i) => ({ label: `Field ${i}`, value: "value" })) },
      sentence: "Mail: " + "😀".repeat(281),
      requesterTitle: "😀".repeat(81),
    },
    options,
  );
  expect(view.details).toHaveLength(8);
  expect(view.details.at(-1)?.label).toBe("Field 7");
  expect(Array.from(view.sentence)).toHaveLength(APP_ACTION_LIMITS.sentenceChars);
  expect(view.sentence.endsWith("…")).toBe(true);
  expect(Array.from(view.requester.title ?? "")).toHaveLength(APP_ACTION_LIMITS.titleChars);
  expect(view.truncated).toBe(true);
  expect(AppActionViewSchema.parse(view)).toEqual(view);
  const summary = appActionSummary(view);
  expect(Array.from(summary.sentence)).toHaveLength(APP_ACTION_LIMITS.summaryChars);
  expect(summary.sentence.endsWith("…")).toBe(true);
  expect(AppActionSummarySchema.parse(summary)).toEqual(summary);
});

test("the byte guard bounds huge multibyte reviews including the digest and keeps schema-valid text", async () => {
  const input = {
    ...row,
    sentence: "😀".repeat(280),
    requesterTitle: "😀".repeat(80),
    details: {
      message: "界".repeat(1000),
      details: Array.from({ length: 8 }, () => ({ label: "😀".repeat(40), value: "😀".repeat(5000) })),
    },
  };
  const names = { ...options, appName: () => "😀".repeat(60) };
  const view = await appActionView(input, names);
  expect(view.truncated).toBe(true);
  expect(view.details.length).toBeLessThan(8);
  expect(new TextEncoder().encode(JSON.stringify(view)).length).toBeLessThanOrEqual(APP_APPROVAL_LIMITS.bodyBytes);
  expect(AppActionViewSchema.parse(view)).toEqual(view);
  expect(view.digest).toBe(await appActionDigest(options.issuer, view));
  expect(await appActionView(input, names)).toEqual(view);
});
