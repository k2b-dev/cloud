import { expect, test } from "bun:test";
import { mailWorkspaceMessages } from "../mail-workspace-messages";
import { parseMailtoIntent } from "./mail-compose-intent";
import { mailComposeDraftSeedInput } from "./mail-compose-seed";
import { mailComposerMessages } from "./mail-composer-messages";

test("empty compose preserves the intent page's literal request without format", () => {
  const expected = {
    origin: {
      kind: "compose" as const,
      input: {
        senderIdentityId: "Send01",
        to: [],
        cc: [],
        bcc: [],
        subject: "",
        body: "",
        intent: "new" as const,
        conversationId: null,
        sourceMessageId: null,
        includeSourceAttachments: false,
      },
    },
  };
  expect(mailComposeDraftSeedInput("Send01")).toEqual(expected);
  const parsed = parseMailtoIntent(null);
  if (!parsed.ok) throw new Error("Empty intent must parse");
  expect(mailComposeDraftSeedInput("Send01", parsed.intent)).toEqual(expected);
});

test("mailto compose preserves recipients and uses plain format for its body", () => {
  const parsed = parseMailtoIntent("mailto:ada@example.test?cc=bo@example.test&subject=Hello&body=Line%201");
  if (!parsed.ok) throw new Error("Fixture mailto must parse");
  expect(mailComposeDraftSeedInput("Send01", parsed.intent)).toEqual({
    origin: {
      kind: "compose" as const,
      input: {
        senderIdentityId: "Send01",
        to: [{ address: "ada@example.test", name: null }],
        cc: [{ address: "bo@example.test", name: null }],
        bcc: [],
        subject: "Hello",
        body: "Line 1",
        format: "plain",
        intent: "new" as const,
        conversationId: null,
        sourceMessageId: null,
        includeSourceAttachments: false,
      },
    },
  });
});

for (const locale of ["en", "de"]) {
  test(`workspace compose feedback matches the composer in ${locale}`, () => {
    const workspace = mailWorkspaceMessages.resolve([locale]).t;
    const composer = mailComposerMessages.resolve([locale]).t;
    for (const key of ["preparingMessage", "draftCreateFailed", "localMessageFailed", "startMessageFailed"] as const) {
      expect(workspace[key]).toBe(composer[key]);
    }
  });
}
