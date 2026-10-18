import { describe, expect, test } from "bun:test";
import { logoJpeg, logoPng } from "../../test/mailbox-logo-fixtures";
import { validateMailboxLogoImage } from "./mailbox-logo-image";

describe("mailbox logo byte validation", () => {
  test("detects PNG and JPEG from bytes regardless of a client media type", () => {
    for (const clientContentType of ["text/html", "image/gif", "image/jpeg"]) {
      const upload = { contentType: clientContentType, bytes: logoPng() };
      expect(validateMailboxLogoImage(upload.bytes)).toEqual({ ok: true, data: { contentType: "image/png", width: 1, height: 1 } });
    }
    expect(validateMailboxLogoImage(logoJpeg())).toEqual({ ok: true, data: { contentType: "image/jpeg", width: 1, height: 1 } });
  });
  test("checks byte size before parsing and reads dimension limits only from headers", () => {
    expect(validateMailboxLogoImage(Buffer.alloc(102401))).toMatchObject({
      ok: false,
      error: { status: 400, message: expect.stringContaining("100 KiB") },
    });
    for (const make of [logoPng, logoJpeg]) {
      for (const [width, height] of [
        [1201, 1],
        [1, 401],
        [1201, 401],
      ]) {
        expect(validateMailboxLogoImage(make(width, height))).toMatchObject({
          ok: false,
          error: { message: expect.stringContaining(`${width}x${height}`) },
        });
      }
      expect(validateMailboxLogoImage(make(1200, 400)).ok).toBe(true);
      expect(validateMailboxLogoImage(make(0, 1)).ok).toBe(false);
      expect(validateMailboxLogoImage(make(1, 0)).ok).toBe(false);
    }
  });
  test("rejects unsupported types and empty input", () => {
    for (const bytes of [
      Buffer.alloc(0),
      Buffer.from("GIF89a"),
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
      Buffer.from("RIFFwebp"),
      Buffer.from("<html>hi</html>"),
    ]) {
      expect(validateMailboxLogoImage(bytes)).toMatchObject({ ok: false, error: { message: expect.stringContaining("PNG or JPEG") } });
    }
  });
  test("rejects polyglots, missing IEND, damaged CRCs, chunk lengths and truncated headers", () => {
    for (const valid of [logoPng(), logoJpeg()]) {
      for (const trailer of [Buffer.from("PK\x03\x04"), Buffer.from("<html>hi</html>")]) {
        expect(validateMailboxLogoImage(Buffer.concat([valid, trailer]))).toMatchObject({
          ok: false,
          error: { message: expect.stringContaining("damaged or truncated") },
        });
      }
      for (let end = 1; end < Math.min(valid.length, 25); end += 1) expect(validateMailboxLogoImage(valid.subarray(0, end)).ok).toBe(false);
      expect(validateMailboxLogoImage(valid.subarray(0, -2)).ok).toBe(false);
    }
    const crc = logoPng();
    crc[29] = (crc[29] ?? 0) ^ 1;
    expect(validateMailboxLogoImage(crc).ok).toBe(false);
    const length = logoPng();
    length.writeUInt32BE(0xffffffff, 33);
    expect(validateMailboxLogoImage(length).ok).toBe(false);
    const header = logoPng();
    header.writeUInt32BE(12, 8);
    expect(validateMailboxLogoImage(header).ok).toBe(false);
    expect(validateMailboxLogoImage(logoPng().subarray(0, -12)).ok).toBe(false);
  });
  test("walks JPEG fill and standalone markers and rejects invalid segment lengths before SOF", () => {
    const jpeg = logoJpeg();
    const prefix = Buffer.from([0xff, 0xff, 0x01, 0xff, 0xd0, 0xff, 0xe0, 0, 4, 1, 2]);
    expect(validateMailboxLogoImage(Buffer.concat([jpeg.subarray(0, 2), prefix, jpeg.subarray(2)])).ok).toBe(true);
    for (const segment of [
      [0xff, 0xe0, 0, 1],
      [0xff, 0xe0, 0xff, 0xff],
      [0xff, 0xc0, 0, 3, 8],
    ]) {
      expect(validateMailboxLogoImage(Buffer.concat([jpeg.subarray(0, 2), Buffer.from(segment), jpeg.subarray(-2)])).ok).toBe(false);
    }
  });
  test("rejects bytes after the first JPEG EOI, even with a final EOI", () => {
    const jpeg = logoJpeg();
    for (const trailer of [Buffer.from("<html>hi</html>\xff\xd9", "binary"), jpeg]) {
      expect(validateMailboxLogoImage(Buffer.concat([jpeg, trailer])).ok).toBe(false);
    }
  });
  test("walks multiple JPEG scans with stuffed bytes, restart markers and marker fill", () => {
    const jpeg = logoJpeg();
    const sof = Buffer.from(jpeg.subarray(2, 15));
    sof[1] = 0xc2;
    const sos = jpeg.subarray(15, 25);
    const scan = Buffer.from([0x7f, 0xff, 0, 0xd9, 0xff, 0xd0, 0x42, 0xff, 0xd7, 0x33]);
    const progressive = Buffer.concat([
      jpeg.subarray(0, 2),
      sof,
      sos,
      scan,
      Buffer.from([0xff]),
      sos,
      scan,
      Buffer.from([0xff, 0xff, 0xd9]),
    ]);
    expect(validateMailboxLogoImage(progressive)).toEqual({ ok: true, data: { contentType: "image/jpeg", width: 1, height: 1 } });
    expect(validateMailboxLogoImage(progressive.subarray(0, -3)).ok).toBe(false);
    expect(validateMailboxLogoImage(Buffer.concat([jpeg.subarray(0, -2), jpeg])).ok).toBe(false);
    const laterSof = logoJpeg(1201, 401).subarray(2, 15);
    expect(validateMailboxLogoImage(Buffer.concat([jpeg.subarray(0, -2), laterSof, jpeg.subarray(-2)])).ok).toBe(true);
  });
  test("rejects a JPEG SOS before the first SOF", () => {
    const jpeg = logoJpeg();
    expect(
      validateMailboxLogoImage(Buffer.concat([jpeg.subarray(0, 2), jpeg.subarray(15, -2), jpeg.subarray(2, 15), jpeg.subarray(-2)])).ok,
    ).toBe(false);
  });
});

test("logo metadata rejects control characters before trimming and bounds base64 input", async () => {
  const { mailboxLogoAltTextSchema, updateMailboxComposeLogoInputSchema } = await import("../contracts");
  expect(mailboxLogoAltTextSchema.parse("  Team  ")).toBe("Team");
  for (const value of ["\nTeam", "Team\r", "Team\u0000", "Team\u007f", "Team\u0085", " ", "x".repeat(201)])
    expect(mailboxLogoAltTextSchema.safeParse(value).success).toBe(false);
  expect(updateMailboxComposeLogoInputSchema.safeParse({ content: Buffer.alloc(102400).toString("base64") }).success).toBe(true);
  for (const content of ["", "abcd=", "ab%+", "a===", "abc", "ab\nc", "YQ==\n", "YQ", "YQ==="])
    expect(updateMailboxComposeLogoInputSchema.safeParse({ content }).success).toBe(false);
});
