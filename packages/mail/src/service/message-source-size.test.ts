import { describe, expect, test } from "bun:test";
import { assessMessageSourceSize } from "./message-source-size";

const message = (lineEnding: string, body: string): Buffer =>
  Buffer.from(
    ["From: Sender <sender@example.com>", "To: Recipient <recipient@example.com>", "Subject: Advisory size", "", body, ""].join(lineEnding),
    "utf8",
  );

describe("message source size", () => {
  test("accepts the exact advertised byte count", () => {
    const delivered = message("\r\n", "Plain body");
    expect(assessMessageSourceSize(delivered.byteLength, delivered.byteLength)).toEqual({ kind: "match" });
  });

  test("ignores a missing or negative advertisement", () => {
    expect(assessMessageSourceSize(42, null)).toEqual({ kind: "match" });
    expect(assessMessageSourceSize(42, undefined)).toEqual({ kind: "match" });
    expect(assessMessageSourceSize(42, -1)).toEqual({ kind: "match" });
  });

  test("keeps a CRLF delivery whose RFC822.SIZE was counted with bare LF", () => {
    const delivered = message("\r\n", "Plain body");
    const advertised = message("\n", "Plain body").byteLength;
    expect(advertised).toBeLessThan(delivered.byteLength);
    expect(assessMessageSourceSize(delivered.byteLength, advertised)).toEqual({
      kind: "advisory_mismatch",
      expectedSize: advertised,
      byteLength: delivered.byteLength,
    });
  });

  test("keeps an 8-bit delivery whose RFC822.SIZE was counted in characters", () => {
    const delivered = message("\r\n", "Grüße aus Köln – 8-bit body");
    const advertised = delivered.toString("utf8").length;
    expect(advertised).toBeLessThan(delivered.byteLength);
    expect(assessMessageSourceSize(delivered.byteLength, advertised)).toMatchObject({ kind: "advisory_mismatch" });
  });

  test("keeps a delivery that is shorter than the advertisement", () => {
    const delivered = message("\r\n", "Plain body");
    expect(assessMessageSourceSize(delivered.byteLength, delivered.byteLength + 17)).toMatchObject({ kind: "advisory_mismatch" });
  });

  test("rejects an empty delivery against a non-empty advertisement", () => {
    expect(() => assessMessageSourceSize(0, 256)).toThrow(
      expect.objectContaining({ code: "MESSAGE_SIZE_MISMATCH", expectedSize: 256, byteLength: 0 }),
    );
    expect(assessMessageSourceSize(0, 0)).toEqual({ kind: "match" });
  });
});
