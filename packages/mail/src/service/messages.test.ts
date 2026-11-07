import { describe, expect, test } from "bun:test";
import { messageForwardTextOf } from "../forward-text";
import { type MessageDetail, mapMessageDetail, messageForwardText } from "./messages";
import type { MailWorkspaceMessage } from "./workspace";

describe("messageForwardText", () => {
  test("prefers the original plain-text alternative", () => {
    expect(messageForwardText("Plain body", "<p>HTML body</p>")).toBe("Plain body");
  });

  test("converts an HTML-only body to readable text", () => {
    const text = messageForwardText(null, '<p>Hello <strong>Ada</strong>.</p><p><a href="https://example.com">Details</a></p>');
    expect(text).toContain("Hello Ada.");
    expect(text).toContain("Details");
    expect(text).not.toContain("<strong>");
  });

  test("uses HTML when an empty plain-text alternative carries no content", () => {
    expect(messageForwardText("", "<p>HTML body</p>")).toBe("HTML body");
    expect(messageForwardText("  \n", "<p>HTML body</p>")).toBe("HTML body");
  });

  test("does not fail the message projection when HTML conversion rejects malformed input", () => {
    expect(typeof messageForwardText(null, "\u0000")).toBe("string");
  });
});

describe("messageForwardTextOf", () => {
  for (const [label, plainText, sanitizedHtml] of [
    ["plain", "  Original plain body\n", "<p>HTML alternative</p>"],
    ["HTML only", null, "<p>Hello <strong>Ada</strong>.</p>"],
    ["empty plain with HTML", "", "<p>HTML body</p>"],
    ["blank plain with HTML", "  \n", "<p>HTML body</p>"],
    ["empty", null, null],
  ] as const) {
    test(`${label}: full and trimmed workspace messages preserve forwarding text`, () => {
      const expected = messageForwardText(plainText, sanitizedHtml);
      const full: MessageDetail = {
        id: "00000000-0000-4000-8000-000000000001",
        messageId: "fixture@example.test",
        subject: "Fixture",
        internalDate: "2026-10-01T12:00:00.000Z",
        sentAt: null,
        from: [],
        to: [],
        replyTo: [],
        cc: [],
        flags: [],
        keywords: [],
        preview: null,
        hasAttachments: false,
        hydrationStatus: "complete",
        remoteAvailable: true,
        folderId: null,
        deletedOnServer: false,
        contentType: sanitizedHtml ? "text/html" : "text/plain",
        sizeBytes: 0,
        plainText,
        sanitizedHtml,
        forwardText: expected,
        selectedHeaders: {},
        sourceAvailable: false,
        mailingList: null,
        remoteContent: { imageIds: [], allowedByRule: false, sender: null, domain: null },
        delivery: null,
        attachments: [],
      };
      const { forwardText: _forwardText, ...withoutForwardText } = full;
      const workspace: MailWorkspaceMessage = plainText?.trim() ? withoutForwardText : full;
      expect(messageForwardTextOf(full)).toBe(expected);
      expect(messageForwardTextOf(workspace)).toBe(expected);
    });
  }

  test("a workspace message without either body returns empty text", () => {
    expect(messageForwardTextOf({ plainText: null })).toBe("");
    expect(messageForwardTextOf({ plainText: "  \n" })).toBe("");
  });
});

describe("mapMessageDetail attachment checksums", () => {
  for (const encoding of ["jsonb", "json"] as const) {
    test(`preserves known and unknown checksums from ${encoding} attachment rows`, () => {
      const attachments: MessageDetail["attachments"] = ["a".repeat(64), "b".repeat(64), null].map((checksum, index) => ({
        id: `Att00${index}`,
        filename: "report.pdf",
        contentType: "application/pdf",
        sizeBytes: 123,
        contentId: null,
        checksum,
      }));
      const message = mapMessageDetail({
        id: "00000000-0000-4000-8000-000000000001",
        subject: "Fixture",
        preview: null,
        has_attachments: true,
        message_id: "fixture@example.test",
        internal_date: "2026-10-01T12:00:00.000Z",
        sent_at: null,
        from_addresses: [],
        to_addresses: [],
        flags: [],
        keywords: [],
        hydration_status: "complete",
        remote_available: true,
        remote_message_ref_id: null,
        folder_id: null,
        deleted_on_server: false,
        content_type: "multipart/mixed",
        size_bytes: 369,
        reply_to_addresses: [],
        cc_addresses: [],
        plain_text: "Fixture body",
        sanitized_html: null,
        selected_headers: {},
        protocol_facts: {},
        source_available: false,
        delivery_submission_id: null,
        delivery_draft_id: null,
        delivery_state: null,
        delivery_attempt: null,
        delivery_scheduled_at: null,
        delivery_undo_until: null,
        delivery_accepted_at: null,
        delivery_error_code: null,
        delivery_error_message: null,
        delivery_provider_response: null,
        attachments: encoding === "json" ? JSON.stringify(attachments) : attachments,
      });
      expect(message.attachments).toEqual(attachments);
      expect(message.attachments.map((attachment) => attachment.checksum)).toEqual(["a".repeat(64), "b".repeat(64), null]);
    });
  }
});
