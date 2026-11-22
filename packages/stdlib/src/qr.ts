/**
 * QR code payload generation and rendering library.
 *
 * Payload generators are pure functions that produce standard QR code strings.
 * Rendering wraps lean-qr to produce scalable SVGs.
 *
 * Imported via the `/qr` subpath so that the root barrel does not pull in the
 * optional `lean-qr` peer dependency for consumers that don't use QR features.
 *
 * @example
 * import { qr } from "@k2b/stdlib/qr";
 *
 * const data = qr.wifi({ ssid: "Office", password: "secret", encryption: "WPA" });
 * const svg = qr.toSvg(data, { correctionLevel: "M", on: "#000", off: "#fff" });
 */

import { generate, correction, type Correction } from "lean-qr";
import { toSvgSource } from "lean-qr/extras/svg";

// ====================================
// TYPES
// ====================================

type CorrectionLevel = "L" | "M" | "Q" | "H";

type WifiOptions = {
  ssid: string;
  password?: string;
  encryption?: "WPA" | "WEP" | "nopass";
  hidden?: boolean;
};

type EmailOptions = {
  to: string;
  subject?: string;
  body?: string;
};

type TelOptions = {
  number: string;
};

type VCardOptions = {
  firstName: string;
  lastName?: string;
  organization?: string;
  title?: string;
  phone?: string;
  email?: string;
  website?: string;
  street?: string;
  city?: string;
  zip?: string;
  country?: string;
};

type EventOptions = {
  title: string;
  location?: string;
  /** datetime-local format: "2025-06-15T14:30" */
  start?: string;
  /** datetime-local format: "2025-06-15T15:30" */
  end?: string;
  description?: string;
};

type RenderOptions = {
  /** Foreground color (default "#000000") */
  on?: string;
  /** Background color (default "#ffffff", or "transparent") */
  off?: string;
  /** Error correction level (default "M") */
  correctionLevel?: CorrectionLevel;
};

// ====================================
// HELPERS
// ====================================

/**
 * Escapes special characters for WiFi QR code fields (SSID and password).
 *
 * Per the WiFi QR code specification, the characters `\ ; , : " '` must be
 * backslash-escaped to avoid being interpreted as field delimiters.
 *
 * @param s - Raw SSID or password string
 * @returns Escaped string safe for WiFi QR payloads
 */
const escapeWifi = (s: string): string => s.replace(/([\\;,:"'`])/g, "\\$1");

/**
 * Escapes special characters for vCard field values per RFC 6350.
 *
 * Backslashes, semicolons, and commas are structural delimiters in vCard
 * and must be backslash-escaped. Newlines are encoded as the literal
 * sequence `\n`.
 *
 * @param s - Raw vCard field value
 * @returns Escaped string safe for vCard payloads
 */
const escapeVCard = (s: string): string =>
  s
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    // Both CR and LF must be escaped; otherwise a value like
    // "John\rEMAIL:evil@example.com" injects a fake EMAIL field into the
    // vCard / iCalendar payload.
    .replace(/\r\n|\r|\n/g, "\\n");

/**
 * Converts an HTML `datetime-local` value to iCalendar VEVENT date-time format.
 *
 * Strips dashes and colons while keeping the `T` separator, and appends
 * `00` seconds when none are present in the input.
 *
 * @param dt - Date-time string in `datetime-local` format (e.g. `"2025-06-15T14:30"`)
 * @returns Compact iCalendar date-time string (e.g. `"20250615T143000"`)
 *
 * @example
 * formatDt("2025-06-15T14:30")   // "20250615T143000"
 * formatDt("2025-06-15T14:30:45") // "20250615T143045"
 */
const formatDt = (dt: string): string => {
  // Remove date dashes and time colons, keep T separator
  const cleaned = dt.replace(/-/g, "").replace(/:/g, "");
  // If no seconds were present (format: YYYYMMDDTHHMMSS would be 15 chars), add "00"
  return cleaned.length === 13 ? cleaned + "00" : cleaned;
};

// ====================================
// PAYLOAD GENERATORS
// ====================================

/**
 * Generates a WiFi QR code payload string.
 *
 * Produces the standard `WIFI:T:<enc>;S:<ssid>;P:<password>;;` format.
 * When encryption is `"nopass"`, the password field is omitted regardless
 * of whether a password value was provided.
 *
 * @param opts - WiFi network configuration
 * @returns WiFi QR payload string
 *
 * @example
 * wifi({ ssid: "Office", password: "secret" })
 * // "WIFI:T:WPA;S:Office;P:secret;;"
 */
const wifi = (opts: WifiOptions): string => {
  const enc = opts.encryption ?? "WPA";
  const parts = [`T:${enc}`, `S:${escapeWifi(opts.ssid)}`];
  if (opts.password && enc !== "nopass") {
    parts.push(`P:${escapeWifi(opts.password)}`);
  }
  if (opts.hidden) {
    parts.push("H:true");
  }
  return `WIFI:${parts.join(";")};;`;
};

/**
 * Generates a `mailto:` QR code payload string.
 *
 * Produces an RFC 6068 `mailto:` URI with optional URL-encoded `subject`
 * and `body` query parameters. Empty or whitespace-only subject/body
 * values are omitted.
 *
 * @param opts - Email address and optional subject/body
 * @returns `mailto:` URI string
 *
 * @example
 * email({ to: "a@b.c", subject: "Hello" })
 * // "mailto:a@b.c?subject=Hello"
 */
const email = (opts: EmailOptions): string => {
  const params: string[] = [];
  if (opts.subject?.trim()) params.push(`subject=${encodeURIComponent(opts.subject.trim())}`);
  if (opts.body?.trim()) params.push(`body=${encodeURIComponent(opts.body.trim())}`);
  return `mailto:${opts.to.trim()}${params.length ? "?" + params.join("&") : ""}`;
};

/**
 * Generates a `tel:` QR code payload string.
 *
 * Wraps the provided phone number in a `tel:` URI after trimming whitespace.
 *
 * @param opts - Phone number configuration
 * @returns `tel:` URI string
 *
 * @example
 * tel({ number: "+49123456" }) // "tel:+49123456"
 */
const tel = (opts: TelOptions): string => `tel:${opts.number.trim()}`;

/**
 * Generates a vCard 3.0 QR code payload string.
 *
 * Produces a complete `BEGIN:VCARD` / `END:VCARD` block with CRLF line
 * endings. All text values are escaped for vCard special characters
 * (backslash, semicolon, comma, newline) via {@link escapeVCard}.
 *
 * Optional fields (organization, title, phone, email, website, address)
 * are only included when their values are truthy.
 *
 * @param opts - Contact information fields
 * @returns vCard 3.0 payload string with CRLF line endings
 */
const vcard = (opts: VCardOptions): string => {
  const lines = [
    "BEGIN:VCARD",
    "VERSION:3.0",
    `N:${escapeVCard(opts.lastName ?? "")};${escapeVCard(opts.firstName)}`,
    `FN:${escapeVCard([opts.firstName, opts.lastName].filter(Boolean).join(" "))}`,
  ];
  if (opts.organization) lines.push(`ORG:${escapeVCard(opts.organization)}`);
  if (opts.title) lines.push(`TITLE:${escapeVCard(opts.title)}`);
  if (opts.phone) lines.push(`TEL:${escapeVCard(opts.phone)}`);
  if (opts.email) lines.push(`EMAIL:${escapeVCard(opts.email)}`);
  if (opts.website) lines.push(`URL:${escapeVCard(opts.website)}`);
  if (opts.street || opts.city || opts.zip || opts.country) {
    lines.push(`ADR:;;${escapeVCard(opts.street ?? "")};${escapeVCard(opts.city ?? "")};;${escapeVCard(opts.zip ?? "")};${escapeVCard(opts.country ?? "")}`);
  }
  lines.push("END:VCARD");
  return lines.join("\r\n");
};

/**
 * Generates an iCalendar VCALENDAR/VEVENT QR code payload string.
 *
 * Produces a complete `BEGIN:VCALENDAR` wrapper containing a single
 * `VEVENT`, with CRLF line endings as required by RFC 5545. Text
 * properties (SUMMARY, LOCATION, DESCRIPTION) are escaped for
 * iCalendar special characters (backslash, semicolon, comma, newline).
 *
 * @param opts - Event details (title, optional location, start/end, description)
 * @returns iCalendar payload string with CRLF line endings
 */
const event = (opts: EventOptions): string => {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//stdlib//EN",
    "BEGIN:VEVENT",
    `SUMMARY:${escapeVCard(opts.title)}`,
  ];
  if (opts.location) lines.push(`LOCATION:${escapeVCard(opts.location)}`);
  if (opts.start) lines.push(`DTSTART:${formatDt(opts.start)}`);
  if (opts.end) lines.push(`DTEND:${formatDt(opts.end)}`);
  if (opts.description) lines.push(`DESCRIPTION:${escapeVCard(opts.description)}`);
  lines.push("END:VEVENT");
  lines.push("END:VCALENDAR");
  return lines.join("\r\n");
};

// ====================================
// RENDERING
// ====================================

const correctionMap: Record<CorrectionLevel, Correction> = {
  L: correction.L,
  M: correction.M,
  Q: correction.Q,
  H: correction.H,
};

/**
 * Renders a QR code as a scalable SVG string.
 *
 * Uses the `lean-qr` library to generate the QR matrix and converts it
 * to an SVG source via `lean-qr/extras/svg`. The SVG uses the specified
 * foreground (`on`) and background (`off`) colors, and the given error
 * correction level.
 *
 * @param data - The string data to encode in the QR code
 * @param opts - Optional rendering configuration (colors, correction level)
 * @returns SVG markup string
 */
const toSvg = (data: string, opts?: RenderOptions): string => {
  const qrCode = generate(data, {
    minCorrectionLevel: correctionMap[opts?.correctionLevel ?? "M"],
  });
  return toSvgSource(qrCode, {
    on: opts?.on ?? "#000000",
    off: opts?.off ?? "#ffffff",
  });
};

// ====================================
// EXPORT
// ====================================

export const qr = {
  wifi,
  email,
  tel,
  vcard,
  event,
  toSvg,
} as const;
