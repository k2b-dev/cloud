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

  test("stops at an Outlook-style header block without a separator", () => {
    const german = "Passt, danke!\n\nVon: Paul Probe\nGesendet: Montag, 28. September 2026 10:00\nAn: Mara\nBetreff: Halle\n\nAlter Text";
    expect(conversationPreviewExcerpt(german, null)).toBe("Passt, danke!");
    const english = "Fine.\n\n*From:* Paul Probe\n*Sent:* Monday\n*To:* Mara\n\nOld text";
    expect(conversationPreviewExcerpt(english, null)).toBe("Fine.");
    // A single "From:" line in the reply itself is no header block.
    expect(conversationPreviewExcerpt("From: the hall office\nKeys are at the desk.", null)).toBe(
      "From: the hall office\nKeys are at the desk.",
    );
  });

  test("keeps bottom-posted and inline replies but drops the quoted lines and their attribution", () => {
    expect(conversationPreviewExcerpt("On Tue, Paul wrote:\n> Can you send the invoice?\n\nSure, attached.", null)).toBe("Sure, attached.");
    const inline = "Hi Paul,\n\n> Is the hall free?\nYes, from 18:00.\n> And the projector?\nThe adapter is in the cupboard.";
    expect(conversationPreviewExcerpt(inline, null)).toBe("Hi Paul,\n\nYes, from 18:00.\n\nThe adapter is in the cupboard.");
  });

  test("shows the forwarded message when a forward has no text of its own", () => {
    const forward = [
      "---------- Forwarded message ---------",
      "From: Paul Probe <paul@example.test>",
      "Date: Mon, 28 Sep 2026 at 10:00",
      "Subject: Hall booking",
      "To: Mara <mara@example.test>",
      "",
      "The hall is booked for Friday.",
    ].join("\n");
    expect(conversationPreviewExcerpt(forward, null)).toBe("The hall is booked for Friday.");
    expect(conversationPreviewExcerpt(`FYI\n\n${forward}`, null)).toBe("FYI");
    const gmail =
      '<div class="gmail_quote"><div>---------- Forwarded message ---------<br>From: Paul &lt;paul@example.test&gt;<br>Date: Mon<br>Subject: Hall<br>To: Mara<br></div><br><br><div>Forwarded body</div></div>';
    expect(conversationPreviewExcerpt(null, gmail)).toBe("Forwarded body");
  });

  test("keeps a colon line that does not introduce a quote", () => {
    expect(conversationPreviewExcerpt("Two points are open:\n\n1. Power\n2. Setup", null)).toBe(
      "Two points are open:\n\n1. Power\n2. Setup",
    );
    // Only an attribution such as "… wrote:" goes with the quote below it.
    expect(conversationPreviewExcerpt("You asked:\n> Is the hall free?\nYes.", null)).toBe("You asked:\n\nYes.");
  });

  test("converts HTML only without a text version, without images, link targets, or quoted history", () => {
    const html = [
      "<p>Good morning,</p>",
      '<p>the invoice lists the hall <a href="https://tracker.example.test/x">twice</a>.</p>',
      '<img src="https://images.example.test/pixel.png" alt="pixel"><img data-mail-remote-image="00000000-0000-4000-8000-000000000001" alt="logo">',
      '<div class="gmail_quote"><div>On Monday Paul wrote:</div><blockquote class="gmail_quote">Old text</blockquote></div>',
    ].join("");
    const excerpt = conversationPreviewExcerpt(null, html);
    expect(excerpt).toBe("Good morning,\n\nthe invoice lists the hall twice.");
    expect(conversationPreviewExcerpt("   ", "<p>Fallback</p><blockquote><p>Quoted</p></blockquote>")).toBe("Fallback");
    expect(conversationPreviewExcerpt("Plain wins", "<p>Html</p>")).toBe("Plain wins");
  });

  test("drops Thunderbird and Outlook history from sanitized HTML", () => {
    // The sanitizer keeps the moz-cite-prefix class but drops Outlook's ids, so Outlook is recognized by its header block.
    expect(
      conversationPreviewExcerpt(
        null,
        '<p>Ok</p><div class="moz-cite-prefix">On 01.10.26 at 10:00, Paul wrote:<br></div><blockquote type="cite">Old</blockquote>',
      ),
    ).toBe("Ok");
    const outlook =
      "<p>Danke!</p><hr><div><font><b>Von:</b> Paul<br><b>Gesendet:</b> Montag<br><b>An:</b> Mara<br><b>Betreff:</b> Halle</font><div>&nbsp;</div></div><div>Alter Text</div>";
    expect(conversationPreviewExcerpt(null, outlook)).toBe("Danke!");
  });

  test("never cuts between the halves of a surrogate pair", () => {
    const excerpt = conversationPreviewExcerpt("😀".repeat(600), null)!;
    expect(excerpt.length).toBeLessThanOrEqual(MAIL_CONVERSATION_PREVIEW_EXCERPT_MAX_LENGTH);
    expect(excerpt.endsWith("😀…")).toBeTrue();
    expect(excerpt.isWellFormed()).toBeTrue();
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
