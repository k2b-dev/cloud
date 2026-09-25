import { describe, expect, test } from "bun:test";
import { NOTICE_CARD_CLASSES, NOTICE_CARD_ICONS } from "@k2b/ui";
import { renderMarkdownSync } from ".";

const cases = [
  ["note", "neutral", "Note"],
  ["info", "info", "Info"],
  ["success", "success", "Success"],
  ["warning", "warning", "Warning"],
  ["danger", "danger", "Danger"],
] as const;

describe("Markdown notice cards", () => {
  test("uses the shared NoticeCard contract for every callout tone", () => {
    for (const [directive, tone] of cases) {
      const html = renderMarkdownSync(`:::${directive}\nBody\n:::`);

      expect(html).toContain(`class="${NOTICE_CARD_CLASSES.root}"`);
      expect(html).toContain(`data-tone="${tone}"`);
      expect(html).toContain(`${NOTICE_CARD_ICONS[tone]} ${NOTICE_CARD_CLASSES.icon}`);
      expect(html).toContain(`class="${NOTICE_CARD_CLASSES.body}"`);
    }
  });

  test("the default card output other applications render stays unchanged", () => {
    expect(renderMarkdownSync(":::warning Before deleting\nBody\n:::")).toBe(
      `<aside class="k2b-notice-card" data-tone="warning">
  <div class="k2b-notice-card__inner">
    <i class="ti ti-alert-triangle k2b-notice-card__icon" aria-hidden="true"></i>
    <div class="k2b-notice-card__content">
      <p class="k2b-notice-card__title">Before deleting</p>
      <div class="k2b-notice-card__body">Body</div>
    </div>
  </div>
</aside>`,
    );
    expect(renderMarkdownSync(":::info\nBody\n:::")).toContain(`<p class="${NOTICE_CARD_CLASSES.title}">Info</p>`);
  });

  test("minimal notices show only the tone colour and keep the type name for screen readers", () => {
    for (const [directive, tone, label] of cases) {
      const html = renderMarkdownSync(`:::${directive}\nBody\n:::`, { notices: "minimal" });

      expect(html).toBe(
        `<aside class="${NOTICE_CARD_CLASSES.root}" data-tone="${tone}" role="note"><span class="sr-only">${label}: </span><div class="${NOTICE_CARD_CLASSES.body}">Body</div></aside>`,
      );
    }
  });

  test("minimal notices keep an explicit title as visible text", () => {
    const html = renderMarkdownSync(":::warning Before <deleting>\nBody\n:::", { notices: "minimal" });

    expect(html).toContain(`<span class="sr-only">Warning: </span><p class="${NOTICE_CARD_CLASSES.title}">Before &lt;deleting&gt;</p>`);
    expect(html).not.toContain(NOTICE_CARD_CLASSES.icon);
  });
});
