import { describe, it, expect } from "bun:test";
import { qr } from "./qr";

// ==========================
// wifi
// ==========================

describe("qr.wifi", () => {
  it("generates WPA wifi payload with default encryption", () => {
    expect(qr.wifi({ ssid: "Home", password: "pass123" })).toBe("WIFI:T:WPA;S:Home;P:pass123;;");
  });

  it("generates nopass wifi payload without password field", () => {
    expect(qr.wifi({ ssid: "Open", encryption: "nopass" })).toBe("WIFI:T:nopass;S:Open;;");
  });

  it("escapes special characters in SSID", () => {
    const result = qr.wifi({ ssid: 'My "Net;work', password: "x" });
    expect(result).toContain('S:My \\"Net\\;work');
  });

  it("includes hidden flag when set", () => {
    expect(qr.wifi({ ssid: "Hidden", password: "x", hidden: true })).toContain("H:true");
  });

  it("omits password for nopass even if password provided", () => {
    const result = qr.wifi({ ssid: "X", password: "y", encryption: "nopass" });
    expect(result).not.toContain("P:");
  });
});

// ==========================
// email
// ==========================

describe("qr.email", () => {
  it("generates basic mailto payload", () => {
    expect(qr.email({ to: "a@b.c" })).toBe("mailto:a@b.c");
  });

  it("includes subject and body when provided", () => {
    const result = qr.email({ to: "a@b.c", subject: "Hi", body: "Hello" });
    expect(result).toBe("mailto:a@b.c?subject=Hi&body=Hello");
  });

  it("URL-encodes subject and body", () => {
    const result = qr.email({ to: "a@b.c", subject: "Hello World" });
    expect(result).toContain("subject=Hello%20World");
  });

  it("trims whitespace from to address", () => {
    expect(qr.email({ to: " a@b.c " })).toBe("mailto:a@b.c");
  });

  it("omits empty subject/body", () => {
    expect(qr.email({ to: "a@b.c", subject: "", body: "" })).toBe("mailto:a@b.c");
    expect(qr.email({ to: "a@b.c", subject: "  ", body: "  " })).toBe("mailto:a@b.c");
  });
});

// ==========================
// tel
// ==========================

describe("qr.tel", () => {
  it("generates tel payload", () => {
    expect(qr.tel({ number: "+49123456" })).toBe("tel:+49123456");
  });

  it("trims whitespace", () => {
    expect(qr.tel({ number: " +49123 " })).toBe("tel:+49123");
  });
});

// ==========================
// vcard
// ==========================

describe("qr.vcard", () => {
  it("generates minimal vcard with firstName only", () => {
    const result = qr.vcard({ firstName: "John" });
    expect(result).toContain("BEGIN:VCARD");
    expect(result).toContain("VERSION:3.0");
    expect(result).toContain("FN:John");
    expect(result).toContain("END:VCARD");
  });

  it("formats N field as lastName;firstName", () => {
    const result = qr.vcard({ firstName: "John", lastName: "Doe" });
    expect(result).toContain("N:Doe;John");
    expect(result).toContain("FN:John Doe");
  });

  it("generates full vcard with all optional fields", () => {
    const result = qr.vcard({
      firstName: "John",
      lastName: "Doe",
      organization: "ACME",
      title: "CEO",
      phone: "+1234",
      email: "j@d.com",
      website: "https://d.com",
      street: "Main St 1",
      city: "Berlin",
      zip: "10115",
      country: "DE",
    });
    expect(result).toContain("ORG:ACME");
    expect(result).toContain("TITLE:CEO");
    expect(result).toContain("TEL:+1234");
    expect(result).toContain("EMAIL:j@d.com");
    expect(result).toContain("URL:https://d.com");
    expect(result).toContain("ADR:;;Main St 1;Berlin;;10115;DE");
  });

  it("omits optional fields when not provided", () => {
    const result = qr.vcard({ firstName: "John" });
    expect(result).not.toContain("ORG:");
    expect(result).not.toContain("TITLE:");
    expect(result).not.toContain("TEL:");
    expect(result).not.toContain("ADR:");
  });

  it("includes ADR when any address field is present", () => {
    const result = qr.vcard({ firstName: "J", city: "Berlin" });
    expect(result).toContain("ADR:");
  });

  // Regression: \r in field values must not inject extra vCard fields.
  it("escapes carriage returns to prevent field injection", () => {
    const result = qr.vcard({
      firstName: "John\rEMAIL:evil@example.com",
    });
    // The literal `EMAIL:evil@example.com` must not appear as a separate
    // field — the \r must be backslash-escaped to \\n inside the FN value.
    expect(result.split("\r\n").filter((l) => l.startsWith("EMAIL:"))).toEqual([]);
    expect(result).toContain("\\n");
  });
});

// ==========================
// event
// ==========================

describe("qr.event", () => {
  it("generates minimal event with title only", () => {
    const result = qr.event({ title: "Meeting" });
    expect(result).toContain("BEGIN:VEVENT");
    expect(result).toContain("SUMMARY:Meeting");
    expect(result).toContain("END:VEVENT");
  });

  it("formats datetime-local to VEVENT format", () => {
    const result = qr.event({ title: "X", start: "2025-06-15T14:30" });
    expect(result).toContain("DTSTART:20250615T143000");
  });

  it("includes all optional fields when provided", () => {
    const result = qr.event({
      title: "Conf",
      location: "Room A",
      start: "2025-06-15T14:30",
      end: "2025-06-15T15:30",
      description: "Annual review",
    });
    expect(result).toContain("LOCATION:Room A");
    expect(result).toContain("DTSTART:20250615T143000");
    expect(result).toContain("DTEND:20250615T153000");
    expect(result).toContain("DESCRIPTION:Annual review");
  });
});

// ==========================
// toSvg
// ==========================

describe("qr.toSvg", () => {
  it("returns valid SVG string", () => {
    const result = qr.toSvg("test");
    expect(result).toContain("<svg");
    expect(result).toContain("</svg>");
  });

  it("uses custom foreground and background colors", () => {
    const result = qr.toSvg("test", { on: "#ff0000", off: "transparent" });
    expect(result).toContain("#ff0000");
  });
});
