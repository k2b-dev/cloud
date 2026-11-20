import { expect, test } from "bun:test";
import { bodyQuotes, defaultReplyQuoteSource } from "./compose-quotation";

test.each([
  ["a Markdown quote line", "> Saturday at 11?\n\nYes.", true],
  ["an indented quote line", "   > Saturday at 11?", true],
  ["an HTML blockquote", "<BlockQuote>Saturday at 11?</BlockQuote>\n\nYes.", true],
  ["plain text", "Saturday at 11 works.", false],
  ["a greater-than sign inside a line", "Order 2 > 1, as agreed.", false],
  ["four spaces make code, not a quote", "    > not a quote", false],
  ["a shell prompt in a fenced code block", "Run this:\n\n```sh\n> echo hello\n```\n\nThanks.", false],
  ["a quote after a fenced code block", "```\ncode\n```\n\n> quoted", true],
])("bodyQuotes: %s", (_name, body, expected) => {
  expect(bodyQuotes(body)).toBe(expected);
});

test("defaultReplyQuoteSource: a choice wins; a reply quotes; a quoting body, a forward or a new message do not", () => {
  const quote = () => "quoted";
  const base = { intent: "reply", sourceMessageId: "Msg001", body: "Yes.", quote };
  expect(defaultReplyQuoteSource({ ...base, quoteSource: undefined })).toBe("quoted");
  expect(defaultReplyQuoteSource({ ...base, intent: "reply_all", quoteSource: undefined })).toBe("quoted");
  expect(defaultReplyQuoteSource({ ...base, quoteSource: null })).toBeNull();
  expect(defaultReplyQuoteSource({ ...base, quoteSource: "chosen" })).toBe("chosen");
  expect(defaultReplyQuoteSource({ ...base, body: "> Saturday?", quoteSource: undefined })).toBeNull();
  expect(defaultReplyQuoteSource({ ...base, intent: "forward", quoteSource: undefined })).toBeNull();
  expect(defaultReplyQuoteSource({ ...base, intent: undefined, quoteSource: undefined })).toBeNull();
  expect(defaultReplyQuoteSource({ ...base, sourceMessageId: undefined, quoteSource: undefined })).toBeNull();
});
