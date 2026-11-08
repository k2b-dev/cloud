import { expect, test } from "bun:test";
import { redactSecrets } from "./http-redaction";

test("echo responses redact exact and prefixed secrets and both base64 forms in headers and bytes", () => {
  const secret = "token?>ÿ",
    sent = "Bearer " + secret;
  const variants = [
    secret,
    sent,
    ...[secret, sent].flatMap((s) => [Buffer.from(s).toString("base64"), Buffer.from(s).toString("base64url")]),
  ];
  const echoed = variants.join(" | ");
  const result = redactSecrets({ headers: { "x-echo": echoed }, body: Buffer.concat([Buffer.from([0xff, 0]), Buffer.from(echoed)]) }, [
    { value: secret, sent },
  ]);
  expect(result.headers["x-echo"]).toBe(variants.map(() => "[REDACTED]").join(" | "));
  expect(result.headers["x-cloud-redacted"]).toBe("secret");
  expect(result.body.subarray(0, 2)).toEqual(Buffer.from([0xff, 0]));
  for (const variant of variants) expect(Buffer.from(result.body).includes(Buffer.from(variant))).toBe(false);
});
test("responses without inserted secrets retain binary bytes and headers", () => {
  const response = { headers: { a: "ok" }, body: new Uint8Array([255, 0, 128]) };
  expect(redactSecrets(response, [])).toEqual(response);
});

test("redaction expansion stays within the response budget and drops case-insensitive length headers", () => {
  const response = { headers: { "Content-Length": "4" }, body: Buffer.from("aaaa") };
  expect(() => redactSecrets(response, [{ value: "a", sent: "a" }], 10)).toThrow("HTTP size budget");
  expect(redactSecrets(response, [{ value: "a", sent: "a" }], 40).headers).toEqual({ "x-cloud-redacted": "secret" });
});

test("inserted secrets that are absent from a response retain its length and have no redaction marker", () => {
  const response = { headers: { "Content-Length": "3", "x-info": "ok" }, body: new Uint8Array([255, 0, 128]) };
  expect(redactSecrets(response, [{ value: "hidden-token", sent: "Bearer hidden-token" }])).toEqual(response);
});

test.each(["headers", "body"])("a replacement in only %s marks the response and removes its length", (area) => {
  const response = {
    headers: { "content-length": "5", "x-info": area === "headers" ? "token" : "ok" },
    body: Buffer.from(area === "body" ? "token" : "other"),
  };
  const result = redactSecrets(response, [{ value: "token", sent: "Bearer token" }]);
  expect(result.headers["x-cloud-redacted"]).toBe("secret");
  expect(result.headers).not.toHaveProperty("content-length");
  expect(result.headers["x-info"]).toBe(area === "headers" ? "[REDACTED]" : "ok");
  expect(Buffer.from(result.body).toString()).toBe(area === "body" ? "[REDACTED]" : "other");
});

test("escaped and URL-encoded echoes of both raw and prefixed secrets are redacted", () => {
  const value = 'quote"/slash\\line\nÿ😀';
  const sent = `Bearer ${value}`;
  for (const secret of [value, sent]) {
    const escaped = JSON.stringify(secret).slice(1, -1);
    const variants = [
      escaped,
      escaped.replaceAll("/", "\\/"),
      escaped.replace(/[\u007f-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`),
      encodeURIComponent(secret),
    ];
    for (const variant of variants) {
      const result = redactSecrets({ headers: { echo: variant }, body: Buffer.from(variant) }, [{ value, sent }]);
      expect(result.headers.echo).toBe("[REDACTED]");
      expect(Buffer.from(result.body).toString()).toBe("[REDACTED]");
    }
  }
});

test("upstream redaction markers cannot be spoofed, with or without inserted secrets", () => {
  for (const secrets of [[], [{ value: "secret", sent: "Bearer secret" }]]) {
    const clean = redactSecrets(
      { headers: { "X-Cloud-Redacted": "secret", "x-cloud-redacted": "forged" }, body: Buffer.from("safe") },
      secrets,
    );
    expect(clean.headers).toEqual({});
  }
  const replaced = redactSecrets({ headers: { "X-CLOUD-REDACTED": "forged" }, body: Buffer.from("secret") }, [
    { value: "secret", sent: "Bearer secret" },
  ]);
  expect(replaced.headers).toEqual({ "x-cloud-redacted": "secret" });
});
