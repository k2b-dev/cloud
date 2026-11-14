import { expect, test } from "bun:test";
import { forwardMessageBody, quoteReplyBody } from "../compose-quotation";
import { hasLegacyReplyBodyEvidence } from "./reply-draft-body-evidence";

const message = {
  from: [{ name: "Ada Lovelace", address: "ada@example.test" }],
  to: [{ address: "team@example.test" }],
  subject: "Delivery",
  internalDate: "2026-09-01T09:00:00.000Z",
  plainText: "Source\n> Already quoted in the source",
};
const realText = "Yes, we can deliver on Friday.";
const signatures = {
  current: "Regards, Ada",
  edited: "The sign-off before its template was edited",
  archived: "The sign-off from an archived template",
  "service-account private": "{{ actor.display_name }}'s private default signature",
};

// Historical appendSignature from before #967: German attributions and forward headers were not recognized.
const legacyAppendSignature = (body: string, signature: string): string => {
  const lines = body.split("\n");
  const quotedAt = lines.findIndex(
    (line, index) =>
      line.startsWith(">") ||
      line === "---------- Forwarded message ----------" ||
      (/\bwrote:\s*$/iu.test(line) && lines.slice(index + 1).some((candidate) => candidate.startsWith(">"))),
  );
  if (quotedAt < 0) return [body.trimEnd(), signature].filter(Boolean).join("\n\n");
  return [lines.slice(0, quotedAt).join("\n").trimEnd(), signature, lines.slice(quotedAt).join("\n").trimStart()]
    .filter(Boolean)
    .join("\n\n");
};

for (const locale of ["en", "de"] as const) {
  const dateContext = { locale, timeZone: "UTC" };
  const histories = {
    reply: quoteReplyBody(message, message.plainText, dateContext),
    forward: forwardMessageBody(message, dateContext),
    plain: "",
  };
  for (const [intent, history] of Object.entries(histories)) {
    for (const [state, signature] of Object.entries(signatures)) {
      test(`${locale} legacy ${intent} with ${state} signature: untouched is empty, real text survives`, () => {
        const segment = `\u2063${signature}\u2064`;
        const untouched = legacyAppendSignature(history, segment);
        if (locale === "de" && intent === "reply") expect(untouched).toContain(`schrieb Ada Lovelace:\n\n${segment}\n\n> Source`);
        expect(hasLegacyReplyBodyEvidence(untouched)).toBeFalse();
        expect(hasLegacyReplyBodyEvidence(legacyAppendSignature([realText, history].filter(Boolean).join("\n\n"), segment))).toBeTrue();
      });
    }
    test(`${locale} exactly-derived ${intent} is not body evidence`, () => {
      expect(hasLegacyReplyBodyEvidence(history)).toBeFalse();
    });
    if (intent !== "plain") {
      test(`${locale} CLI --body text in a ${intent} counts without a signature`, () => {
        expect(hasLegacyReplyBodyEvidence(`${realText}\n\n${history}`)).toBeTrue();
      });
    }
  }
}

test("signature-only bodies remove every complete segment, including adjacent ones", () => {
  expect(hasLegacyReplyBodyEvidence("\n\n\u2063One\u2064\n\n\u2063Two\u2064\u2063Three\u2064\n\n")).toBeFalse();
});

test("leftover marks do not count, while unmarked text is retained", () => {
  expect(hasLegacyReplyBodyEvidence("\u2063\n\u2064")).toBeFalse();
  expect(hasLegacyReplyBodyEvidence(`\u2063${realText}`)).toBeTrue();
  expect(hasLegacyReplyBodyEvidence(`\u2064${realText}`)).toBeTrue();
  expect(hasLegacyReplyBodyEvidence(realText)).toBeTrue();
});
