import { expect, test } from "bun:test";
import {
  isHintId,
  MAX_SEEN_HINTS,
  mergeSeenHints,
  parseSeenHintsCookieHeader,
  SEEN_HINTS_COOKIE,
  seenHintsSetCookie,
  serializeSeenHints,
} from "./seen-hints";

test("parses only this cookie, tolerates garbage, and retains newest unique valid ids", () => {
  for (const value of [undefined, null, "", "garbage", "other=files.tags", "cloud_seen_hints=%broken"]) {
    expect(parseSeenHintsCookieHeader(value)).toEqual([]);
  }
  expect(parseSeenHintsCookieHeader("other=x; cloud_seen_hints=files.tags~bad/id~~mail.old~files.tags~UPPER; next=y")).toEqual([
    "mail.old",
    "files.tags",
  ]);
});

test("hint ids use the bounded public grammar", () => {
  for (const id of [null, undefined, 12, {}, []]) expect(isHintId(id)).toBe(false);
  for (const id of ["a", "files.tags", "a-_.0", "a".repeat(64)]) expect(isHintId(id)).toBe(true);
  for (const id of ["", "A", ".a", "a/b", "a b", "a~b", "a,b", "a;cookie=x", "a".repeat(65)]) {
    expect(isHintId(id)).toBe(false);
    expect(() => mergeSeenHints([], id)).toThrow("Invalid hint id");
  }
});

test("merge refreshes recency, removes invalid ids, and drops oldest beyond the cap", () => {
  const ids = Array.from({ length: MAX_SEEN_HINTS + 4 }, (_, i) => `hint.${i}`);
  expect(parseSeenHintsCookieHeader(`${SEEN_HINTS_COOKIE}=${ids.join("~")}`)).toEqual(ids.slice(4));
  expect(mergeSeenHints(ids, "hint.4")).toEqual([...ids.slice(5), "hint.4"]);
  expect(mergeSeenHints(["bad/id", "a", "b", "a"], "b")).toEqual(["a", "b"]);
});

test("serialization round trips with a cookie-octet-safe separator and bounded normalization", () => {
  const value = serializeSeenHints(["a", "bad/id", "b", "a"]);
  expect(value).toBe("b~a");
  expect(value).not.toContain(",");
  expect(parseSeenHintsCookieHeader(`${SEEN_HINTS_COOKIE}=${value}`)).toEqual(["b", "a"]);
});

test("cookie persists for a year, is readable by the browser, and adds Secure only on HTTPS", () => {
  const cookie = "cloud_seen_hints=files.tags; Path=/; Max-Age=31536000; SameSite=Lax";
  expect(seenHintsSetCookie(["files.tags"], false)).toBe(cookie);
  expect(seenHintsSetCookie(["files.tags"], true)).toBe(`${cookie}; Secure`);
});

test("maximum-length ids also fit the browser cookie budget by dropping the oldest first", () => {
  const ids = Array.from({ length: MAX_SEEN_HINTS }, (_, i) => `hint.${i}.`.padEnd(64, "x"));
  const cookie = seenHintsSetCookie(ids, true);
  expect(cookie.length).toBeLessThanOrEqual(4096);
  const parsed = parseSeenHintsCookieHeader(cookie);
  expect(parsed.length).toBeLessThan(MAX_SEEN_HINTS);
  expect(parsed).toEqual(ids.slice(-parsed.length));
  expect(serializeSeenHints(parsed)).toBe(serializeSeenHints(ids));
  const next = "new.hint".padEnd(64, "x");
  expect(mergeSeenHints(ids, next).at(-1)).toBe(next);
  expect(seenHintsSetCookie(mergeSeenHints(ids, next), true).length).toBeLessThanOrEqual(4096);
});
