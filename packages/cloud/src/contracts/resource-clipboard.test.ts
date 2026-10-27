import { describe, expect, it } from "bun:test";
import {
  CLOUD_RESOURCE_CLIPBOARD_MAX_BYTES,
  formatCloudResourceUrl,
  parseCloudResourceClipboard,
  parseCloudResourceUrl,
  serializeCloudResourceClipboard,
} from "./resource-clipboard";

describe("Cloud resource clipboard contract", () => {
  it("round-trips one stable resource reference", () => {
    const ref = { type: "grids.record", id: "A8vcaK" };

    expect(
      parseCloudResourceClipboard(serializeCloudResourceClipboard({ cloudUrl: "https://cloud.example", ref }), "https://cloud.example"),
    ).toEqual(ref);
  });

  it("scopes references to the configured Cloud URL", () => {
    const value = serializeCloudResourceClipboard({
      cloudUrl: "https://first.cloud.example",
      ref: { type: "grids.record", id: "A8vcaK" },
    });

    expect(parseCloudResourceClipboard(value, "https://second.cloud.example")).toBeNull();
  });

  it("rejects unknown versions, fields, and invalid references", () => {
    expect(parseCloudResourceClipboard('{"version":2,"ref":{"type":"grids.record","id":"A8vcaK"}}', "https://cloud.example")).toBeNull();
    expect(
      parseCloudResourceClipboard(
        '{"version":1,"cloudUrl":"https://cloud.example","ref":{"type":"grids.record","id":"A8vcaK"},"title":"Camera"}',
        "https://cloud.example",
      ),
    ).toBeNull();
    expect(
      parseCloudResourceClipboard(
        '{"version":1,"cloudUrl":"https://cloud.example","ref":{"type":"record","id":"A8vcaK"}}',
        "https://cloud.example",
      ),
    ).toBeNull();
  });

  it("rejects malformed and oversized payloads", () => {
    expect(parseCloudResourceClipboard("not json", "https://cloud.example")).toBeNull();
    expect(parseCloudResourceClipboard("x".repeat(CLOUD_RESOURCE_CLIPBOARD_MAX_BYTES + 1), "https://cloud.example")).toBeNull();
  });
});

describe("Cloud resource permalink text", () => {
  const cloudUrl = "https://cloud.example";

  it("formats the permalink and reads it back", () => {
    const ref = { type: "mail.message", id: "Msg001" };
    const url = formatCloudResourceUrl(ref, cloudUrl);

    expect(url).toBe("https://cloud.example/open/mail.message/~Msg001");
    expect(parseCloudResourceUrl(url, cloudUrl)).toEqual(ref);
    expect(parseCloudResourceUrl("  /open/mail.message/~Msg001\n", cloudUrl)).toEqual(ref);
  });

  it("round-trips ids with reserved characters and dot segments", () => {
    for (const id of [".", "..", "a b/c?d#e", "ü~%41", "x".repeat(512)]) {
      const ref = { type: "files.entry", id };
      expect(parseCloudResourceUrl(formatCloudResourceUrl(ref, cloudUrl), cloudUrl)).toEqual(ref);
    }
  });

  it("accepts only this Cloud's exact permalink", () => {
    for (const value of [
      "",
      "Msg001",
      "mail.message:Msg001",
      "https://other.example/open/mail.message/~Msg001",
      "//other.example/open/mail.message/~Msg001",
      "https://cloud.example/open/mail.message/Msg001",
      "https://cloud.example/open/mail.message/~Msg001?x=1",
      "https://cloud.example/open/mail.message/~Msg001#top",
      "https://cloud.example/open/mail.message/~Msg001/more",
      "https://cloud.example/app/mail/Box001",
      "https://cloud.example/open/Not A Type/~Msg001",
      "https://cloud.example/open/mail.message/~%E0%A4%A",
      "https://cloud.example/open/mail.message/~" + "x".repeat(513),
    ]) {
      expect(parseCloudResourceUrl(value, cloudUrl)).toBeNull();
    }
  });

  it("refuses to format an invalid reference", () => {
    expect(() => formatCloudResourceUrl({ type: "mail", id: "Msg001" }, cloudUrl)).toThrow();
    expect(() => formatCloudResourceUrl({ type: "mail.message", id: "" }, cloudUrl)).toThrow();
  });
});
