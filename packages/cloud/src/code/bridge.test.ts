import { expect, test } from "bun:test";
import { codeHttpOriginAllowed } from "../api/capabilities";

test("Code HTTP refuses every own origin, credentials and non-HTTPS URLs", () => {
  const own = ["https://cloud.example", "https://cloud.example:8443", "http://app-core:3000"];
  for (const url of [
    "https://cloud.example/secret",
    "https://cloud.example:443/a",
    "https://CLOUD.EXAMPLE/a",
    "https://cloud.example./a",
    "https://cloud.example../a",
    "https://cloud.example.../a",
    "https://cloud.example:8443/a",
    "http://app-core:3000/a",
    "http://external.example/a",
    "file:///etc/passwd",
    "https://user:password@external.example/a",
    "invalid",
  ])
    expect(codeHttpOriginAllowed(url, own)).toBe(false);
  expect(codeHttpOriginAllowed("https://external.example/a", own)).toBe(true);
  expect(codeHttpOriginAllowed("https://cloud.example.evil.example/a", own)).toBe(true);
  expect(codeHttpOriginAllowed("https://cloud.example:9443/a", own)).toBe(true);
});

test("an invalid installation origin fails closed", () => {
  expect(codeHttpOriginAllowed("https://external.example", ["invalid app.url"])).toBe(false);
});
