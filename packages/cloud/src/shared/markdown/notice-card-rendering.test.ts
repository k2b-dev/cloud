import { describe, expect, test } from "bun:test";
import { NOTICE_CARD_CLASSES } from "@k2b/ui";
import { renderHelpMarkdown, renderMarkdownSync } from ".";

const cases = [
  ["note", "neutral", "Note"],
  ["info", "info", "Info"],
  ["success", "success", "Success"],
  ["warning", "warning", "Warning"],
  ["danger", "danger", "Danger"],
] as const;

describe("Markdown notice cards", () => {
  test("every callout is a calm NoticeCard: tone tint, no icon, type name for screen readers", () => {
    for (const [directive, tone, label] of cases) {
      const html = renderMarkdownSync(`:::${directive}\nBody\n:::`);

      expect(html).toBe(
        `<aside class="${NOTICE_CARD_CLASSES.root}" data-tone="${tone}" role="note"><span class="sr-only">${label}: </span><div class="${NOTICE_CARD_CLASSES.body}">Body</div></aside>`,
      );
    }
  });

  test("an explicit title is the visible heading", () => {
    const html = renderMarkdownSync(":::warning Before <deleting>\nBody\n:::");

    expect(html).toContain(`<span class="sr-only">Warning: </span><p class="${NOTICE_CARD_CLASSES.title}">Before &lt;deleting&gt;</p>`);
    expect(html).not.toContain("<i");
  });

  test("Help and plain-link rendering produce the same callout", () => {
    const source = ":::info Who can delete\nOnly **managers**.\n:::";
    const expected = renderMarkdownSync(source);

    expect(renderHelpMarkdown(source)).toBe(expected);
    expect(renderMarkdownSync(source, { links: "plain" })).toBe(expected);
  });
});
