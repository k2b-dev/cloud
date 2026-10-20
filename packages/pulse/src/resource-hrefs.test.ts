import { describe, expect, test } from "bun:test";
import { pulseBaseHref, pulseSourceHref } from "./resource-hrefs";

describe("Pulse resource hrefs", () => {
  test("builds canonical encoded base and source paths", () => {
    const baseId = "Base01";
    expect(pulseBaseHref(baseId)).toBe(`/app/pulse/${baseId}`);
    expect(pulseSourceHref(baseId, "source/one")).toBe(`/app/pulse/${baseId}/sources/source%2Fone`);
  });
});
