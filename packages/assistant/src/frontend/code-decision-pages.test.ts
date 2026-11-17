import { afterEach, expect, spyOn, test } from "bun:test";
import { loadCodeDecisionPages } from "./code-decision-pages";

let restore = () => {};
afterEach(() => restore());
function response(status: number, data: unknown) {
  const fetch = spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(data), { status }));
  restore = () => fetch.mockRestore();
  return fetch;
}
const links = {
  versionId: "v",
  homeUrl: "/code/c_demo/",
  pages: [{ entrypoint: "home", title: "Lieferscheine", path: "/", href: "/code/c_demo/", isRoot: true }],
};

test("the activation event reads authorized pages through Core's existing preview, without model tools", async () => {
  const fetch = response(200, { data: { title: "Lieferungen", pages: links } });
  expect(await loadCodeDecisionPages("c_demo", "v")).toEqual({ title: "Lieferungen", pages: links });
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch.mock.calls[0]?.[0]).toBe("/api/code/activation/preview");
});
test("readers and revoked access get no card", async () => {
  for (const status of [403, 404]) {
    response(status, {});
    expect(await loadCodeDecisionPages("c_demo", "v")).toBeNull();
    restore();
  }
});
test("no page, paused Code and an old active version have no card", async () => {
  for (const pages of [null, { ...links, homeUrl: null, pages: [] }]) {
    response(200, { data: { title: "Lieferungen", pages } });
    expect(await loadCodeDecisionPages("c_demo", "v")).toBeNull();
    restore();
  }
});
test("transport and malformed answers expose a recoverable failure", async () => {
  for (const status of [200, 500]) {
    response(status, {});
    expect(await loadCodeDecisionPages("c_demo", "v")).toBe("failed");
    restore();
  }
});
