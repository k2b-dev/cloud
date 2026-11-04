import { describe, expect, test } from "bun:test";
import { attachmentPreviewSignatureMatches } from "../../attachment-preview-policy";
import {
  attachmentPreviewKind,
  formatMailMessageDateTime,
  markCidImageSources,
  messageDeliveryAllowsResponses,
  messageDeliveryControlLabel,
  messageDeliveryPresentation,
  messagePreviewText,
  normalizeContentId,
  referencedContentIds,
  referencedRemoteImageIds,
  resolveMessageBodyFormat,
  resolveMessageColors,
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
    ).toBe("16:30 Aug 6, 2026");
  });

  test("collapses the quoted earlier conversation at the end of a reply", () => {
    expect(
      splitPlainMessageSegments("Thanks, that works.\n\nOn Monday, Alex Example wrote:\n> Does Tuesday suit you?\n>\n> Alex\n"),
    ).toEqual([
      { kind: "content", text: "Thanks, that works.\n\nOn Monday, Alex Example wrote:" },
      { kind: "quote", text: "> Does Tuesday suit you?\n>\n> Alex" },
    ]);
  });

  test("keeps blank lines within the trailing quoted block", () => {
    expect(splitPlainMessageSegments("Reply\n> first\n\n\n> second")).toEqual([
      { kind: "content", text: "Reply" },
      { kind: "quote", text: "> first\n\n\n> second" },
    ]);
  });

  test("collapses trailing history above a signature and keeps the signature visible", () => {
    expect(splitPlainMessageSegments("Agreed.\n\n> Shall we start at nine?\n\n-- \nRiley Sample")).toEqual([
      { kind: "content", text: "Agreed.\n" },
      { kind: "quote", text: "> Shall we start at nine?" },
      { kind: "content", text: "\n-- \nRiley Sample" },
    ]);
  });

  test("keeps inline answers between quotes visible", () => {
    const text = "See my answers below.\n\n> Can you send the plan?\nYes, attached.\n\n> And the budget?\nNext week.";
    expect(splitPlainMessageSegments(text)).toEqual([{ kind: "content", text }]);
  });

  test("keeps a bottom-posted answer and its quote visible", () => {
    const text = "> Is the room booked?\n\nYes, room 4 from ten.";
    expect(splitPlainMessageSegments(text)).toEqual([{ kind: "content", text }]);
  });

  test("keeps a lone quoted line inside the text visible", () => {
    const text = "The sign said:\n> No parking\nso we moved the car.";
    expect(splitPlainMessageSegments(text)).toEqual([{ kind: "content", text }]);
  });

  test("keeps a message that is only quoted text visible", () => {
    const text = "> A quoted note without any reply";
    expect(splitPlainMessageSegments(text)).toEqual([{ kind: "content", text }]);
  });

  test("collapses attributed history after inline answers but keeps an unanswered closing quote visible", () => {
    expect(
      splitPlainMessageSegments("> Can you send the plan?\nYes, attached.\n\nOn Monday, Alex Example wrote:\n> Thanks in advance."),
    ).toEqual([
      { kind: "content", text: "> Can you send the plan?\nYes, attached.\n\nOn Monday, Alex Example wrote:" },
      { kind: "quote", text: "> Thanks in advance." },
    ]);
    const unanswered = "> Can you send the plan?\nYes, attached.\n\n> And the budget?";
    expect(splitPlainMessageSegments(unanswered)).toEqual([{ kind: "content", text: unanswered }]);
  });

  test("keeps a quote with only its attribution above it visible", () => {
    for (const text of [
      "On Monday, Alex Example wrote:\n> The meeting is cancelled.",
      "Am Montag schrieb Erika Muster:\n\n> Das Treffen fällt aus.",
    ]) {
      expect(splitPlainMessageSegments(text)).toEqual([{ kind: "content", text }]);
    }
  });

  test("keeps forwarded originals visible", () => {
    const apple =
      "For your records.\n\nBegin forwarded message:\n\n> From: Sam Example <sam@example.com>\n> Subject: Invoice\n>\n> Attached.";
    const german = "Zur Info.\n\nAnfang der weitergeleiteten Nachricht:\n\n> Von: Sam Beispiel <sam@example.com>\n>\n> Anbei.";
    const quotedMarker = "FYI\n\n> ---------- Forwarded message ---------\n> From: Sam Example <sam@example.com>\n>\n> Agenda below.";
    const gmail = "FYI\n\n---------- Forwarded message ---------\nFrom: Sam Example <sam@example.com>\nSubject: Agenda\n\nAgenda below.";
    const historyInForward = `${gmail}\n\nOn Monday, Riley Sample wrote:\n> The budget is approved.`;
    for (const text of [apple, german, quotedMarker, gmail, historyInForward]) {
      expect(splitPlainMessageSegments(text)).toEqual([{ kind: "content", text }]);
    }
  });

  test("does not collapse ordinary attribution or indentation", () => {
    expect(splitPlainMessageSegments("On Monday, Alex wrote:\n  ordinary indented text")).toEqual([
      {
        kind: "content",
        text: "On Monday, Alex wrote:\n  ordinary indented text",
      },
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
    expect(messagePreviewText("> Is the room booked?\n\nYes, room 4.", "")).toBe("Yes, room 4.");
    expect(messagePreviewText(null, "HTML fallback\nwith spacing")).toBe("HTML fallback with spacing");
    expect(messagePreviewText("123456789", "", 6)).toBe("12345…");
  });

  test("selects the preferred body format with deterministic fallback and per-message override", () => {
    expect(resolveMessageBodyFormat("automatic", null, true, true)).toBe("html");
    expect(resolveMessageBodyFormat("html", null, true, true)).toBe("html");
    expect(resolveMessageBodyFormat("plain", null, true, true)).toBe("plain");
    expect(resolveMessageBodyFormat("automatic", "plain", true, true)).toBe("plain");
    expect(resolveMessageBodyFormat("plain", "html", true, true)).toBe("html");
    expect(resolveMessageBodyFormat("automatic", null, false, true)).toBe("plain");
    expect(resolveMessageBodyFormat("plain", null, true, false)).toBe("html");
    expect(resolveMessageBodyFormat("automatic", "plain", true, false)).toBe("html");
    expect(resolveMessageBodyFormat("automatic", "html", false, true)).toBe("plain");
    expect(resolveMessageBodyFormat("automatic", null, false, false)).toBeNull();
  });

  test("adapts colors unless the reading preference or per-message override requests originals", () => {
    expect(resolveMessageColors("automatic", null)).toBe("adapted");
    expect(resolveMessageColors("plain", null)).toBe("adapted");
    expect(resolveMessageColors("html", null)).toBe("original");
    expect(resolveMessageColors("automatic", "original")).toBe("original");
    expect(resolveMessageColors("html", "adapted")).toBe("adapted");
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

  test("localizes delivery badges and actions for German, de-CH, and unknown-locale fallback", () => {
    expect(messageDeliveryPresentation("sending", "de")).toMatchObject({ label: "Wird gesendet", tone: "running" });
    expect(messageDeliveryPresentation("failed", "de-CH")).toMatchObject({
      label: "Konnte nicht gesendet werden",
      tone: "error",
    });
    expect(messageDeliveryControlLabel("undo_window", true, "de-CH")).toBe("Senden rückgängig machen");
    expect(messageDeliveryPresentation("unknown", "fr")?.label).toBe("Delivery status unclear");
    expect(messageDeliveryControlLabel("scheduled", true, "fr")).toBe("Scheduled");
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

    // A temporary SMTP rejection retries within its own window, so it shows no attempt count.
    expect(messageDeliveryPresentation(delivery)).toMatchObject({ label: "Trying again", tone: "warning" });
    expect(messageDeliveryPresentation({ ...delivery, lastErrorCode: "OUTBOX_PREDISPATCH_RETRY" })).toMatchObject({
      label: "Trying again · 2/5",
      tone: "warning",
    });
    // Waiting for the mailbox's next login is no retry and counts no attempt.
    const waiting = { ...delivery, lastErrorCode: "MAILBOX_AUTH_REQUIRED" };
    expect(messageDeliveryPresentation(waiting)).toMatchObject({ label: "Waiting for sign-in", tone: "warning" });
    expect(messageDeliveryControlLabel(waiting, true, "de")).toBe("Wartet auf Anmeldung");
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

  test("marks CID image sources with their normalized Content-ID", () => {
    expect(normalizeContentId(" <Logo@Example.COM> ")).toBe("logo@example.com");
    expect(markCidImageSources('<img src="cid:Logo%40Example.COM"><img src="cid:a%22b"><a href="cid:logo@example.com">link</a>')).toBe(
      '<img data-mail-cid="logo@example.com"><img data-mail-cid="a&quot;b"><a href="cid:logo@example.com">link</a>',
    );
  });

  test("extracts only normalized CIDs referenced by image sources", () => {
    expect(
      referencedContentIds('<img src="cid:Logo%40Example.COM"><img src="cid:logo@example.com"><a href="cid:ignored@example.com">link</a>'),
    ).toEqual(["logo@example.com"]);
    // The stored Content-ID has no NUL, so a reference that encodes one still matches it.
    expect(referencedContentIds('<img src="cid:logo%00@example.com">')).toEqual(["logo@example.com"]);
  });

  test("extracts opaque remote image references", () => {
    const first = "00000000-0000-4000-8000-000000000001";
    const second = "00000000-0000-4000-8000-000000000002";
    const html = `<img alt="known" data-mail-remote-image="${first}"><img data-mail-remote-image="${second.toUpperCase()}">`;
    expect(referencedRemoteImageIds(html)).toEqual([first, second]);
  });
});
