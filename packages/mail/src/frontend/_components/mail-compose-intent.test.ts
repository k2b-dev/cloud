import { describe, expect, test } from "bun:test";
import { parseMailtoIntent } from "./mail-compose-intent";

describe("parseMailtoIntent", () => {
  test("returns an empty intent when no mailto value is present", () => {
    expect(parseMailtoIntent(null)).toEqual({
      ok: true,
      intent: { to: [], cc: [], bcc: [], subject: "", body: "" },
    });
  });

  test("parses standard recipients, subject, and body without treating plus as a space", () => {
    expect(
      parseMailtoIntent(
        "mailto:alice+tag@example.com,bob@example.com?cc=carol@example.com&bcc=ops@example.com&subject=Hello%20there&body=One%0D%0ATwo",
      ),
    ).toEqual({
      ok: true,
      intent: {
        to: [
          { address: "alice+tag@example.com", name: null },
          { address: "bob@example.com", name: null },
        ],
        cc: [{ address: "carol@example.com", name: null }],
        bcc: [{ address: "ops@example.com", name: null }],
        subject: "Hello there",
        body: "One\nTwo",
      },
    });
  });

  test("combines path and repeated recipient headers while deduplicating addresses", () => {
    const result = parseMailtoIntent(
      "mailto:alice@example.com?to=bob@example.com&to=Alice%20%3Calice@example.com%3E&cc=carol@example.com,dave@example.com",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.intent.to).toEqual([
      { address: "alice@example.com", name: "Alice" },
      { address: "bob@example.com", name: null },
    ]);
    expect(result.intent.cc.map((recipient) => recipient.address)).toEqual(["carol@example.com", "dave@example.com"]);
  });

  test("ignores unsupported headers instead of granting extra compose authority", () => {
    expect(parseMailtoIntent("mailto:alice@example.com?from=attacker@example.com&attachment=file:///secret&send=true")).toEqual({
      ok: true,
      intent: {
        to: [{ address: "alice@example.com", name: null }],
        cc: [],
        bcc: [],
        subject: "",
        body: "",
      },
    });
  });

  test("rejects malformed encoding, invalid recipients, repeated scalar fields, and oversized links", () => {
    expect(parseMailtoIntent("mailto:%E0%A4%A")).toEqual({ ok: false, code: "invalid_encoding" });
    expect(parseMailtoIntent("mailto:not-an-address")).toEqual({ ok: false, code: "invalid_to" });
    expect(parseMailtoIntent("mailto:a@example.com?subject=one&subject=two")).toEqual({ ok: false, code: "duplicate_field" });
    expect(parseMailtoIntent(`mailto:a@example.com?body=${"x".repeat(32 * 1024)}`)).toEqual({ ok: false, code: "too_large" });
  });

  test("removes header line breaks from the subject", () => {
    const result = parseMailtoIntent("mailto:a@example.com?subject=Hello%0D%0ABcc%3Aevil@example.com");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.intent.subject).toBe("Hello Bcc:evil@example.com");
  });
});
