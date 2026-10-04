import { afterEach, expect, spyOn, test } from "bun:test";
import { Hono } from "hono";
import { isServer } from "solid-js/web";
import { z } from "zod";
import { createDomTestHarness, type DomTestHarness } from "../../../ui/test/dom";
import { createApiClient } from "./api-client";
import { v } from "./middleware/validator";

const routes = new Hono().post("/items/:id/done", v("json", z.object({ at: z.number() })), (c) => c.json({ id: c.req.param("id") }));
type Answer = Response | "offline";

let dom: DomTestHarness | undefined;
let restore: (() => void) | undefined;
afterEach(() => {
  restore?.();
  dom?.cleanup();
});

/** A page at `path` whose requests get the answers in order; it records each request and every page it leaves for. */
const page = (path: string, answers: Answer[]) => {
  dom = createDomTestHarness();
  dom.window.history.replaceState(null, "", path);
  const replaced: string[] = [];
  Object.assign(dom.window.location, { replace: (url: string) => void replaced.push(url) });
  const calls: string[] = [];
  const spy = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (input: string | URL | Request, init?: RequestInit) => {
        calls.push(`${init?.method ?? "GET"} ${String(input)}${typeof init?.body === "string" ? ` ${init.body}` : ""}`);
        const answer = answers.shift();
        if (!answer) throw new Error(`No answer left for ${String(input)}`);
        if (answer === "offline") throw new TypeError("Failed to fetch");
        return answer;
      },
      { preconnect: globalThis.fetch.preconnect },
    ),
  );
  restore = () => spy.mockRestore();
  return { calls, replaced, client: createApiClient<typeof routes>({ baseUrl: "/api/inventory" }) };
};
const ended = () => Response.json({ message: "Unauthorized" }, { status: 401 });
const done = () => Response.json({ id: "7" });

if (isServer) test.skip("requires browser conditions", () => {});
else {
  test("on a page of the mobile app, an expired session is renewed and the request is sent once more", async () => {
    const { calls, client } = page("/pwa/inventory", [
      ended(),
      Response.json({ renewed: true }),
      Response.json({ renewed: false }),
      done(),
    ]);
    const response = await client.items[":id"].done.$post({ param: { id: "7" }, json: { at: 1 } });
    expect(response.status).toBe(200);
    expect(calls).toEqual([
      'POST /api/inventory/items/7/done {"at":1}',
      "POST /pwa/_auth/session/renew",
      // After a rotation, the second call retires the old device key.
      "POST /pwa/_auth/session/renew",
      'POST /api/inventory/items/7/done {"at":1}',
    ]);
  });

  test("requests that fail together share one renewal", async () => {
    const { calls, client } = page("/pwa/inventory", [ended(), ended(), Response.json({ renewed: false }), done(), done()]);
    const responses = await Promise.all(["1", "2"].map((id) => client.items[":id"].done.$post({ param: { id }, json: { at: 1 } })));
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(calls.filter((call) => call.includes("/session/renew"))).toHaveLength(1);
  });

  test("an ended pairing leads to the pairing view, and an unreachable Cloud keeps the first answer", async () => {
    let current = page("/pwa/inventory", [ended(), ended()]);
    expect((await current.client.items[":id"].done.$post({ param: { id: "7" }, json: { at: 1 } })).status).toBe(401);
    expect(current.replaced).toEqual(["/pwa/?pwa=ended"]);
    restore?.();
    dom?.cleanup();

    current = page("/pwa/inventory", [ended(), "offline"]);
    expect((await current.client.items[":id"].done.$post({ param: { id: "7" }, json: { at: 1 } })).status).toBe(401);
    expect(current.calls).toHaveLength(2);
    expect(current.replaced).toEqual([]);
  });

  test("on the web, a 401 is the answer", async () => {
    const { calls, client } = page("/app/inventory", [ended()]);
    expect((await client.items[":id"].done.$post({ param: { id: "7" }, json: { at: 1 } })).status).toBe(401);
    expect(calls).toHaveLength(1);
  });
}
