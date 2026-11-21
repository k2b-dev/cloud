import { describe, expect, test } from "bun:test";
import { retrySource } from "./picture";

describe("retrySource", () => {
  test("the first try asks the source itself", () => {
    expect(retrySource("/api/filesv2/entries/a/image?rev=r1#top", 0)).toBe("/api/filesv2/entries/a/image?rev=r1#top");
  });

  test("a later try adds its number to the query, before a fragment", () => {
    expect(retrySource("/img/a.png", 1)).toBe("/img/a.png?retry=1");
    expect(retrySource("/img/a.png?rev=r1", 2)).toBe("/img/a.png?rev=r1&retry=2");
    expect(retrySource("/img/a.svg#vase", 1)).toBe("/img/a.svg?retry=1#vase");
    expect(retrySource("/img/a.svg?rev=r1#vase", 2)).toBe("/img/a.svg?rev=r1&retry=2#vase");
    // A question mark inside the fragment is not a query.
    expect(retrySource("/img/a.svg#part?x", 1)).toBe("/img/a.svg?retry=1#part?x");
  });
});
