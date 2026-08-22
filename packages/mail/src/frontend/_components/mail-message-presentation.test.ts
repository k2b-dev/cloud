import { describe, expect, test } from "bun:test";
import { attachmentPreviewSignatureMatches } from "../../attachment-preview-policy";
import {
  attachmentPreviewKind,
  formatMailMessageDateTime,
  messageDeliveryAllowsResponses,
  messageDeliveryControlLabel,
  messageDeliveryPresentation,
  messagePreviewText,
  normalizeContentId,
  referencedContentIds,
  referencedRemoteImageIds,
  resolveMessageBodyFormat,
  rewriteCidSources,
  rewriteRemoteImageSources,
  splitPlainMessageSegments,
  splitPlainTextLinks,
  undoSendSecondsRemaining,
} from "./mail-message-presentation";

describe("mail message presentation", () => {
  test("shows message time and date in the configured timezone", () => {
    expect(
      formatMailMessageDateTime("2026-08-06T14:30:00.000Z", {
        locale: "en",
        timeZone: "Europe/Berlin",
      }),
    ).toBe("16:30 06 Aug 2026");
  });

  test("keeps plain content and quoted history in ordered segments", () => {
    expect(splitPlainMessageSegments("Answer\n\n> Older line\n>\n> Older detail\n\nClosing")).toEqual([
      { kind: "content", text: "Answer\n" },
      { kind: "quote", text: "> Older line\n>\n> Older detail" },
      { kind: "content", text: "\nClosing" },
    ]);
  });

  test("does not collapse ordinary attribution or indentation", () => {
    expect(splitPlainMessageSegments("On Monday, Alex wrote:\n  ordinary indented text")).toEqual([
      {
        kind: "content",
        text: "On Monday, Alex wrote:\n  ordinary indented text",
      },
    ]);
  });

  test("keeps blank lines within a quoted block", () => {
    expect(splitPlainMessageSegments("Reply\n> first\n\n\n> second\nAfter")).toEqual([
      { kind: "content", text: "Reply" },
      { kind: "quote", text: "> first\n\n\n> second" },
      { kind: "content", text: "After" },
    ]);
  });

  test("recognizes safe web links in plain text and keeps surrounding punctuation", () => {
    expect(splitPlainTextLinks("See https://example.com/a_(b), then http://example.org?q=1.")).toEqual([
      { kind: "text", text: "See " },
      { kind: "link", text: "https://example.com/a_(b)", href: "https://example.com/a_(b)" },
      { kind: "text", text: ", then " },
      { kind: "link", text: "http://example.org?q=1", href: "http://example.org?q=1" },
      { kind: "text", text: "." },
    ]);
  });

  test("does not turn non-web protocols or malformed URLs into links", () => {
    expect(splitPlainTextLinks("javascript:alert(1) mailto:test@example.com https://")).toEqual([
      { kind: "text", text: "javascript:alert(1) mailto:test@example.com https://" },
    ]);
  });

  test("builds a bounded one-line preview from new content rather than quoted history", () => {
    expect(messagePreviewText("Short answer\n\n> much older text", "")).toBe("Short answer");
    expect(messagePreviewText(null, "HTML fallback\nwith spacing")).toBe("HTML fallback with spacing");
    expect(messagePreviewText("123456789", "", 6)).toBe("12345…");
  });

  test("selects the preferred body format with deterministic fallback and per-message override", () => {
    expect(resolveMessageBodyFormat("automatic", null, "light", true, true)).toBe("html");
    expect(resolveMessageBodyFormat("automatic", null, "dark", true, true)).toBe("plain");
    expect(resolveMessageBodyFormat("html", null, "dark", true, true)).toBe("html");
    expect(resolveMessageBodyFormat("plain", null, "light", true, true)).toBe("plain");
    expect(resolveMessageBodyFormat("automatic", "plain", "light", true, true)).toBe("plain");
    expect(resolveMessageBodyFormat("automatic", "html", "dark", true, true)).toBe("html");
    expect(resolveMessageBodyFormat("automatic", null, "light", false, true)).toBe("plain");
    expect(resolveMessageBodyFormat("automatic", null, "dark", true, false)).toBe("html");
    expect(resolveMessageBodyFormat("automatic", null, "dark", false, false)).toBeNull();
  });

  test("keeps normal sent delivery quiet and presents exceptional delivery states", () => {
    expect(messageDeliveryPresentation("accepted")).toBeNull();
    expect(messageDeliveryPresentation("sent_sync_pending")).toBeNull();
    expect(messageDeliveryPresentation("sent")).toBeNull();
    expect(messageDeliveryPresentation("reconciled_accepted")).toBeNull();
    expect(messageDeliveryPresentation("sending")).toMatchObject({ label: "Sending", tone: "running" });
    expect(messageDeliveryPresentation("failed")).toMatchObject({ label: "Couldn’t send", tone: "error" });
  });

  test("offers cancellation only while a queued delivery remains controllable", () => {
    expect(messageDeliveryControlLabel("undo_window", true)).toBe("Undo send");
    expect(messageDeliveryControlLabel("scheduled", true)).toBe("Scheduled");
    expect(messageDeliveryControlLabel("sending", true)).toBeNull();
    expect(messageDeliveryControlLabel("undo_window", false)).toBeNull();
  });

  test("distinguishes retries, partial sending, sent-copy trouble, and an unclear outcome", () => {
    const delivery = {
      submissionId: "delivery",
      draftId: "draft",
      state: "scheduled" as const,
      attempt: 2,
      maxAttempts: 5,
      scheduledAt: "2026-08-21T16:00:00.000Z",
      undoUntil: null,
      acceptedAt: null,
      lastErrorCode: "SMTP_TRANSIENT_REJECTION",
      lastErrorMessage: "Temporary rejection",
      acceptedRecipients: [],
      rejectedRecipients: [],
    };

    expect(messageDeliveryPresentation(delivery)).toMatchObject({ label: "Trying again · 2/5", tone: "warning" });
    expect(
      messageDeliveryPresentation({
        ...delivery,
        state: "needs_attention",
        lastErrorCode: "SMTP_PARTIAL_ACCEPTANCE",
        acceptedRecipients: ["accepted@example.com"],
        rejectedRecipients: ["rejected@example.com"],
      }),
    ).toMatchObject({ label: "Partially sent", tone: "warning" });
    expect(messageDeliveryPresentation({ ...delivery, state: "needs_attention", lastErrorCode: "SENT_APPEND_FAILED" })).toMatchObject({
      label: "Sent, but not saved",
      tone: "warning",
    });
    expect(messageDeliveryPresentation({ ...delivery, state: "unknown" })).toMatchObject({
      label: "Delivery status unclear",
      tone: "warning",
    });
  });

  test("does not expose response actions before outgoing delivery is accepted", () => {
    expect(messageDeliveryAllowsResponses("undo_window")).toBeFalse();
    expect(messageDeliveryAllowsResponses("sending")).toBeFalse();
    expect(messageDeliveryAllowsResponses("failed")).toBeFalse();
    expect(messageDeliveryAllowsResponses("accepted")).toBeTrue();
    expect(messageDeliveryAllowsResponses("sent")).toBeTrue();
  });

  test("turns the server undo deadline into a non-negative countdown", () => {
    const now = Date.parse("2026-07-27T21:00:00.000Z");
    expect(undoSendSecondsRemaining("2026-07-27T21:00:10.001Z", now)).toBe(11);
    expect(undoSendSecondsRemaining("2026-07-27T21:00:10.000Z", now)).toBe(10);
    expect(undoSendSecondsRemaining("2026-07-27T20:59:59.000Z", now)).toBe(0);
    expect(undoSendSecondsRemaining(null, now)).toBeNull();
    expect(undoSendSecondsRemaining("not-a-date", now)).toBeNull();
  });

  test("allows only bounded browser-safe attachment previews", () => {
    expect(attachmentPreviewKind("image/png", 1024)).toBe("image");
    expect(attachmentPreviewKind("image/svg+xml", 1024)).toBeNull();
    expect(attachmentPreviewKind("text/html", 1024)).toBeNull();
    expect(attachmentPreviewKind("application/pdf; name=report.pdf", 1024)).toBe("pdf");
    expect(attachmentPreviewKind("text/plain", 3 * 1024 * 1024)).toBeNull();
    expect(attachmentPreviewKind("video/mp4", 60 * 1024 * 1024)).toBeNull();
  });

  test("rejects declared binary preview types with mismatched signatures", () => {
    expect(attachmentPreviewSignatureMatches("application/pdf", new TextEncoder().encode("%PDF-1.7"))).toBeTrue();
    expect(attachmentPreviewSignatureMatches("application/pdf", new TextEncoder().encode("<html>"))).toBeFalse();
    expect(attachmentPreviewSignatureMatches("image/png", Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBeTrue();
    expect(attachmentPreviewSignatureMatches("image/png", new TextEncoder().encode("not-png"))).toBeFalse();
  });

  test("rewrites only known CID image sources to permission-checked object URLs", () => {
    const urls = new Map([["logo@example.com", "blob:https://cloud.example/cid-logo"]]);
    expect(normalizeContentId(" <Logo@Example.COM> ")).toBe("logo@example.com");
    expect(
      rewriteCidSources(
        '<img src="cid:Logo%40Example.COM"><img src="cid:unknown@example.com"><a href="cid:logo@example.com">link</a>',
        urls,
      ),
    ).toBe('<img src="blob:https://cloud.example/cid-logo"><img src="cid:unknown@example.com"><a href="cid:logo@example.com">link</a>');
  });

  test("extracts only normalized CIDs referenced by image sources", () => {
    expect(
      referencedContentIds('<img src="cid:Logo%40Example.COM"><img src="cid:logo@example.com"><a href="cid:ignored@example.com">link</a>'),
    ).toEqual(["logo@example.com"]);
  });

  test("rewrites only known opaque remote image references", () => {
    const first = "00000000-0000-4000-8000-000000000001";
    const second = "00000000-0000-4000-8000-000000000002";
    const html = `<img alt="known" data-mail-remote-image="${first}"><img data-mail-remote-image="${second}">`;
    expect(referencedRemoteImageIds(html)).toEqual([first, second]);
    expect(rewriteRemoteImageSources(html, new Map([[first, "blob:https://cloud.example/remote-image"]]))).toBe(
      `<img alt="known" src="blob:https://cloud.example/remote-image" data-mail-remote-image="${first}"><img data-mail-remote-image="${second}">`,
    );
  });
});
