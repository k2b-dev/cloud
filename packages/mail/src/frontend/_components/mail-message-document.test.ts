import { expect, test } from "bun:test";
import { buildMessageDocument } from "./mail-message-document";

const policyOf = (document: string) => /http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(document)?.[1] ?? "";

test("without the shared typeface the message frame loads no font and no stylesheet", () => {
  const document = buildMessageDocument("<p>Hallo</p>", "mail-message-1");
  expect(policyOf(document)).not.toContain("font-src");
  expect(document).not.toContain('<link rel="stylesheet"');
});

test("with the page's origin the frame may load exactly Cloud's shared fonts.css and its faces", () => {
  const document = buildMessageDocument(
    "<p>Hallo</p>",
    "mail-message-1",
    false,
    "de",
    undefined,
    "light",
    "",
    "https://cloud.example/app/mail?x=1",
  );
  expect(policyOf(document)).toContain("style-src 'unsafe-inline' https://cloud.example/public/fonts.css;");
  expect(policyOf(document)).toContain("font-src https://cloud.example/public/fonts/;");
  expect(document).toContain('<link rel="stylesheet" href="https://cloud.example/public/fonts.css">');
});

test("a value that is no URL adds nothing to the frame's policy", () => {
  const document = buildMessageDocument("<p>Hallo</p>", "mail-message-1", false, "de", undefined, "light", "", "x; script-src *");
  expect(policyOf(document)).not.toContain("font-src");
  expect(policyOf(document)).not.toContain("script-src *");
});
