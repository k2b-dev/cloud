import { describe, expect, test } from "bun:test";
import { buildMessageDocument, estimateInitialMessageBodyHeight, normalizeMessageBodyHeight } from "./mail-message-document";

describe("MailMessageBody sizing", () => {
  test("measures the intrinsic message root instead of the iframe viewport", () => {
    const document = buildMessageDocument("<p>Short message</p>", "test-channel");

    expect(document).toContain('<div id="mail-message-root"><p>Short message</p></div>');
    expect(document).toContain("root?.getBoundingClientRect().height");
    expect(document).toContain("new ResizeObserver(reportHeight).observe(root)");
    expect(document).not.toContain("document.documentElement.scrollHeight");
  });

  test("keeps reported heights finite without truncating long messages", () => {
    expect(normalizeMessageBodyHeight(1)).toBe(32);
    expect(normalizeMessageBodyHeight(48.2)).toBe(49);
    expect(normalizeMessageBodyHeight(200_000)).toBe(200_000);
    expect(normalizeMessageBodyHeight(Number.POSITIVE_INFINITY)).toBe(32);
    expect(normalizeMessageBodyHeight(Number.NaN)).toBe(32);
  });

  test("estimates a deterministic visible SSR height before the exact frame measurement", () => {
    expect(estimateInitialMessageBodyHeight(null, null)).toBe(32);
    expect(estimateInitialMessageBodyHeight("Short message", null)).toBe(32);
    expect(estimateInitialMessageBodyHeight("Line one\nLine two\nLine three", null)).toBe(68);
    expect(estimateInitialMessageBodyHeight("Message", "<table><tr><td>Message</td></tr></table>")).toBe(120);
    expect(estimateInitialMessageBodyHeight("x".repeat(10_000), null)).toBe(480);
  });

  test("collapses only explicit HTML quote containers", () => {
    const document = buildMessageDocument(
      '<p>Neuer Inhalt</p><blockquote type="cite">Alter Inhalt</blockquote>',
      "test-channel",
      false,
      "de",
      { show: "Zitierten Text anzeigen", hide: "Zitierten Text ausblenden" },
    );

    expect(document).toContain('<html lang="de">');
    expect(document).toContain('const quotedTextLabels = {"show":"Zitierten Text anzeigen","hide":"Zitierten Text ausblenden"}');
    expect(document).toContain('blockquote[type="cite"], .gmail_quote, .yahoo_quoted');
  });

  test("shows quoted text behind a chevron toggle instead of the native disclosure marker", () => {
    const document = buildMessageDocument('<blockquote type="cite">Earlier message</blockquote>', "test-channel");

    expect(document).toContain("details.mail-quoted-history > summary::-webkit-details-marker { display: none; }");
    expect(document).toContain("list-style: none");
    expect(document).toContain('path.setAttribute("d", "M9 6l6 6l-6 6")');
    expect(document).toContain("details.mail-quoted-history[open] > summary > svg { transform: rotate(90deg); }");
  });

  test("escapes iframe language and quote labels at their output boundaries", () => {
    const document = buildMessageDocument("<p>Safe content</p>", "test-channel", false, 'de\" onload=\"alert(1)', {
      show: "</script><script>alert(1)</script>",
      hide: "Hide",
    });

    expect(document).toContain('<html lang="de&quot; onload=&quot;alert(1)">');
    expect(document).toContain('{"show":"\\u003c/script>\\u003cscript>alert(1)\\u003c/script>","hide":"Hide"}');
    expect(document).not.toContain("<script>alert(1)");
  });

  test("allows only the app-owned iframe bridge script", () => {
    const document = buildMessageDocument("<p>Safe content</p>", "channel-123");

    expect(document).toContain("script-src 'nonce-channel123'");
    expect(document).toContain('<script nonce="channel123">');
    expect(document).toContain('data.source !== "cloud-mail-host"');
    expect(document).toContain('data.type === "measure"');
    expect(document).toContain('data.type === "images"');
    expect(document).not.toContain("script-src 'unsafe-inline'");
  });

  test("keeps HTML mail on an opaque light canvas in every app theme", () => {
    const document = buildMessageDocument("<p>Readable content</p>", "test-channel");

    expect(document).toContain(":root { color-scheme: only light; }");
    expect(document).toContain("background: #fff; color: #18181b;");
  });

  test("disables navigation inside contained messages", () => {
    const document = buildMessageDocument('<a href="https://lookalike.example">Open</a>', "test-channel", true);

    expect(document).toContain("const linksDisabled = true");
    expect(document).toContain('link.removeAttribute("href")');
    expect(document).toContain('link.setAttribute("aria-disabled", "true")');
  });
});
