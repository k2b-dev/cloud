import { expect, test } from "bun:test";
import { validateCreateLink } from "./store";

const input = { purpose: "customer.login", subject: "mia@example.test", ttl: 900 };

test("create validates purpose, UTF-8 byte length and required TTL bounds", () => {
  for (const purpose of ["", "A", ".login", "a_b", "a/b", "a".repeat(65)]) {
    expect(() => validateCreateLink({ ...input, purpose })).toThrow("Purpose name");
  }
  for (const ttl of [NaN, Infinity, 59, 2592001]) {
    expect(() => validateCreateLink({ ...input, ttl })).toThrow("ttl");
  }
  // @ts-expect-error ttl is required for every created link.
  expect(() => validateCreateLink({ purpose: "login", subject: "customer" })).toThrow("ttl");
  expect(() => validateCreateLink({ ...input, subject: "ü".repeat(513) })).toThrow("1024 UTF-8 bytes");
  for (const ttl of [60, 900, 2592000]) validateCreateLink({ ...input, ttl, subject: "ü".repeat(512) });
  validateCreateLink({ ...input, subject: "" });
  validateCreateLink({ ...input, subject: "before\0after" });
  validateCreateLink({ ...input, purpose: "a".repeat(64) });
});
