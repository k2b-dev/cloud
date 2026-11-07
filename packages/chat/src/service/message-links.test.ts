import { expect, test } from "bun:test";
import { extractMessageLinks } from "./message-links";

test("extracts rendered web destinations in Markdown order without counting code, images or unsafe links", () => {
  expect(
    extractMessageLinks(
      [
        "[balanced](https://example.test/a_(b)) <http://example.test/auto>",
        "https://example.test/bare. [duplicate](https://example.test/a_(b))",
        "[relative](/local) [unsafe](javascript:alert(1)) <mailto:person@example.test>",
        "![image](https://example.test/image) `https://example.test/code`",
        "\n```\nhttps://example.test/fenced\n```\n",
        "[reference][doc]\n\n[doc]: https://example.test/reference",
      ].join("\n"),
    ),
  ).toEqual(["https://example.test/a_(b)", "http://example.test/auto", "https://example.test/bare", "https://example.test/reference"]);
});

test("limits unique links and excludes oversized destinations without truncating URLs", () => {
  const urls = Array.from({ length: 21 }, (_, i) => `https://example.test/${i}`);
  const boundary = `https://example.test/${"x".repeat(2048 - "https://example.test/".length)}`;
  expect(extractMessageLinks(`[too long](${boundary}x) [boundary](${boundary})`)).toEqual([boundary]);
  expect(extractMessageLinks([urls[0], ...urls].join(" "))).toEqual(urls.slice(0, 20));
});
