import { expect, test } from "bun:test";
import { capabilitiesHref, capabilitiesQuery, executionFilter, parseCapabilitiesAddress } from "./query";

const user = "5de41b38-a3ac-47f3-b47c-da6472afbb42";
const query = (named: { app?: string; capability?: string } = {}) =>
  capabilitiesQuery("en", { apps: ["mail"], capabilities: ["mail.send"] }, named);
const read = (search: string, named?: { app?: string; capability?: string }) =>
  parseCapabilitiesAddress(query(named), new URLSearchParams(search));

test("the address of before v2 still reads: filters, keyset cursor and the open request round-trip", () => {
  const search = `app=mail&capability=mail.send&origin=mcp&status=denied&destructive=1&window=7d&user=${user}`;
  const address = read(`${search}&cursor=2026-01-01|abc&request=r-1&tab=apps`);
  expect(address.issues).toEqual([]);
  expect([address.tab, address.cursor, address.request]).toEqual(["apps", "2026-01-01|abc", "r-1"]);
  const href = capabilitiesHref(query(), address.state, { tab: address.tab, cursor: address.cursor });
  expect(read(href.slice(href.indexOf("?") + 1)).state).toEqual(address.state);
  expect(href).toContain("cursor=2026-01-01%7Cabc");
});

test("hand-edited values are named and dropped; an app without calls in the window still reads as itself", () => {
  const address = read("origin=telepathy&status=exploded&user=not-a-uuid");
  expect(address.issues.map((issue) => issue.param).sort()).toEqual(["origin", "status", "user"]);
  expect([address.state.filters.origin, address.state.filters.status, address.state.filters.user]).toEqual([
    undefined,
    undefined,
    undefined,
  ]);
  expect(read("app=contacts", { app: "contacts" }).state.filters.app).toBe("contacts");
});

test("the store filter has no empty constraints and starts at the window", () => {
  const now = Date.parse("2026-11-26T12:00:00Z");
  expect(executionFilter(read("window=1h").state, now)).toEqual({ since: new Date(now - 3_600_000) });
  expect(
    executionFilter(read(`app=mail&capability=mail.send&origin=assistant&status=failed&destructive=1&user=${user}`).state, now),
  ).toEqual({
    appId: "mail",
    capability: "mail.send",
    origin: "assistant",
    status: "failed",
    userId: user,
    destructive: true,
    since: new Date(now - 86_400_000),
  });
});
