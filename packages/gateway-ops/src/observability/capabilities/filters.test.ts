import { describe, expect, test } from "bun:test";
import { capabilitiesFilter, executionFilter, windowStart } from "./filters";

const parse = (query: string) => capabilitiesFilter.parse(new URL(`http://cloud/admin/observability/capabilities${query}`));

describe("capability observability URL state", () => {
  test("defaults to the last day, unfiltered", () => {
    expect(parse("")).toEqual({
      app: "",
      capability: "",
      origin: "all",
      status: "all",
      user: "",
      destructive: false,
      window: "24h",
      request: "",
      cursor: "",
    });
  });

  test("round-trips filters and the keyset cursor", () => {
    const state = parse("?app=contacts&capability=contacts.list&origin=mcp&status=denied&destructive=1&window=7d&cursor=2026-01-01|abc");
    expect(capabilitiesFilter.parse(new URL(`http://cloud${capabilitiesFilter.build(state)}`))).toEqual(state);
  });

  test("rejects hand-edited enums and user ids", () => {
    expect(parse("?origin=telepathy").origin).toBe("all");
    expect(parse("?status=exploded").status).toBe("all");
    expect(parse("?window=forever").window).toBe("24h");
    expect(parse("?user=not-a-uuid").user).toBe("");
    expect(parse("?user=5de41b38-a3ac-47f3-b47c-da6472afbb42").user).toBe("5de41b38-a3ac-47f3-b47c-da6472afbb42");
  });

  test("clearing keeps the time window and drops every other filter", () => {
    const state = parse("?app=mail&status=failed&destructive=1&window=30d&cursor=abc");
    expect(capabilitiesFilter.clear(state, ["window"])).toBe("/admin/observability/capabilities?window=30d");
    expect(capabilitiesFilter.isActive(state, ["window"])).toBe(true);
    expect(capabilitiesFilter.isActive(parse("?window=30d"), ["window"])).toBe(false);
  });

  test("translates URL state into a store filter without empty constraints", () => {
    expect(executionFilter(parse("?window=1h"))).toEqual({ since: expect.any(Date) });
    const filter = executionFilter(parse("?app=mail&capability=mail.send&origin=assistant&status=failed&destructive=1&user=5de41b38-a3ac-47f3-b47c-da6472afbb42"));
    expect(filter).toMatchObject({
      appId: "mail",
      capability: "mail.send",
      origin: "assistant",
      status: "failed",
      destructive: true,
      userId: "5de41b38-a3ac-47f3-b47c-da6472afbb42",
    });
  });

  test("wider windows start further back", () => {
    expect(windowStart("90d").getTime()).toBeLessThan(windowStart("1h").getTime());
  });
});
