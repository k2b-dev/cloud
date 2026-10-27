import { expect, test } from "bun:test";
import { simpleParser } from "mailparser";
import { mailMessageTextLength } from "./message-text";

test.each([
  ["  A😀B  ", 3],
  ["Hello\r\n\r\n-- \r\nLong signature", 5],
  ["Hello\n\nOn Monday, Customer wrote:\n> Quoted history", 5],
  ["> Old question\n\nAnswer\n\n> Another question\n\nReply", 14],
  ["Hello\n\n-----Original Message-----\nFrom: Sender\nSent: Monday\nOld", 5],
  ["-----Original Message-----\nFrom: Sender\nSent: Monday\nOld", 0],
  ["From: Sender\nSent: Monday\nOld", 0],
  ["Hello\nRegards\nName", 18],
  ["", 0],
])("counts own plain text with conservative signature stripping: %j", (text, length) => {
  expect(mailMessageTextLength(text)).toBe(length);
});

test("counts the imported plain text of an HTML-only MIME message", async () => {
  const parsed = await simpleParser(
    [
      "From: sender@example.test",
      "To: recipient@example.test",
      "Date: Mon, 01 Jun 2026 08:00:00 +0000",
      "MIME-Version: 1.0",
      "Content-Type: text/html; charset=utf-8",
      "",
      "<p>Hello</p>",
    ].join("\r\n"),
    { skipHtmlToText: false, skipTextToHtml: true },
  );
  expect(parsed.text?.trim()).toBe("Hello");
  expect(mailMessageTextLength(parsed.text ?? "")).toBe(5);
});
