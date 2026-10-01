import { describe, expect, test } from "bun:test";
import {
  conversationPreviewExcerpt,
  conversationPreviewSummary,
  MAIL_CONVERSATION_PREVIEW_EXCERPT_MAX_LENGTH,
  MAIL_CONVERSATION_PREVIEW_SUMMARY_MAX_LENGTH,
} from "./conversation-preview";

describe("conversationPreviewExcerpt", () => {
  test("keeps the reply and its line breaks but drops the quoted history and its attribution", () => {
    const text = [
      "Hello Jonas,",
      "",
      "here is the revised offer.",
      "",
      "",
      "",
      "Best regards",
      "Mara",
      "",
      "On Tue, 22 Sep 2026 at 10:00, Jonas Muster",
      "<jonas@example.test> wrote:",
      "> Thanks for the second version.",
      "> Can we do something about the LED wall?",
    ].join("\r\n");
    expect(conversationPreviewExcerpt(text, null)).toBe("Hello Jonas,\n\nhere is the revised offer.\n\nBest regards\nMara");
  });

  test("stops at forwarded or original-message separators", () => {
    expect(conversationPreviewExcerpt("See below.\n\n-------- Ursprüngliche Nachricht --------\nVon: Paul", null)).toBe("See below.");
    expect(conversationPreviewExcerpt("Short note\n________________________________\nFrom: Paul", null)).toBe("Short note");
  });

  test("keeps a colon line that does not introduce a quote", () => {
    expect(conversationPreviewExcerpt("Two points are open:\n\n1. Power\n2. Setup", null)).toBe(
      "Two points are open:\n\n1. Power\n2. Setup",
    );
  });

  test("converts HTML only without a text version, without images, link targets, or quoted history", () => {
    const html = [
      "<p>Good morning,</p>",
      '<p>the invoice lists the hall <a href="https://tracker.example.test/x">twice</a>.</p>',
      '<img src="https://images.example.test/pixel.png" alt="pixel"><img data-mail-remote-image="00000000-0000-4000-8000-000000000001" alt="logo">',
      '<div class="gmail_quote"><div class="gmail_attr">On Monday Paul wrote:</div><blockquote>Old text</blockquote></div>',
    ].join("");
    const excerpt = conversationPreviewExcerpt(null, html);
    expect(excerpt).toBe("Good morning,\n\nthe invoice lists the hall twice.");
    expect(conversationPreviewExcerpt("   ", "<p>Fallback</p><blockquote><p>Quoted</p></blockquote>")).toBe("Fallback");
    expect(conversationPreviewExcerpt("Plain wins", "<p>Html</p>")).toBe("Plain wins");
  });

  test("returns null without readable text and cuts long text at a word within the budget", () => {
    expect(conversationPreviewExcerpt(null, null)).toBeNull();
    expect(conversationPreviewExcerpt("> only a quote", null)).toBeNull();
    const long = conversationPreviewExcerpt(Array.from({ length: 400 }, (_, index) => `word${index}`).join(" "), null)!;
    expect(long.length).toBeLessThanOrEqual(MAIL_CONVERSATION_PREVIEW_EXCERPT_MAX_LENGTH);
    expect(long.endsWith("…")).toBeTrue();
    expect(long.slice(0, -1).endsWith(" ")).toBeFalse();
    expect(conversationPreviewExcerpt("x".repeat(5_000), null)!.length).toBe(MAIL_CONVERSATION_PREVIEW_EXCERPT_MAX_LENGTH);
  });
});

describe("conversationPreviewSummary", () => {
  test("renders stored Markdown as one plain paragraph", () => {
    expect(conversationPreviewSummary("## Offer v3\n\n- **18,400 €** gross\n- Reply by [10 October](https://example.test)")).toBe(
      "Offer v3 • 18,400 € gross • Reply by 10 October",
    );
  });

  test("returns null without a summary and bounds a long one", () => {
    expect(conversationPreviewSummary(null)).toBeNull();
    expect(conversationPreviewSummary("  ")).toBeNull();
    expect(conversationPreviewSummary("a ".repeat(2_000))!.length).toBeLessThanOrEqual(MAIL_CONVERSATION_PREVIEW_SUMMARY_MAX_LENGTH);
  });
});
