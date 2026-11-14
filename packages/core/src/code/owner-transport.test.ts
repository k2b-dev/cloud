import { afterEach, expect, spyOn, test } from "bun:test";
import * as cloud from "@k2b/cloud";
import * as owner from "@k2b/cloud/capabilities/server";
import { CAPABILITY_MAX_RESULT_BYTES } from "@k2b/cloud/contracts";
import { readCodeResourceOwnerTitle } from "./owner-transport";

const principal = "22222222-2222-4222-8222-222222222222";
const ref = { type: "example.item", id: "A" };
const restores: Array<() => void> = [];
afterEach(() => {
  for (const restore of restores.splice(0).reverse()) restore();
});
function inspect(response: () => Response) {
  const registry = spyOn(cloud, "getApp").mockResolvedValue({
    id: "example",
    name: "Example",
    icon: "ti ti-code",
    description: "Fixture",
    baseUrl: "http://example.internal",
    routes: ["/example"],
  });
  const sign = spyOn(owner, "signCodeOwnerRead").mockResolvedValue("owner-token");
  const request = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () => response(), { preconnect: fetch.preconnect }));
  restores.push(
    () => registry.mockRestore(),
    () => sign.mockRestore(),
    () => request.mockRestore(),
  );
  return { sign, request };
}
test("owner reads carry only the exact owner reference and account, never target rights", async () => {
  const { sign, request } = inspect(() => Response.json({ data: { title: "Owner" } }));
  const controller = new AbortController();
  expect(await readCodeResourceOwnerTitle(ref, principal, controller.signal)).toBe("Owner");
  expect(sign.mock.calls[0]).toEqual(["example", principal]);
  const [url, init] = request.mock.calls[0]!;
  expect(String(url)).toBe("http://example.internal/api/_internal/capabilities/v1/code-owner/queries/code.owner.title");
  expect(init).toMatchObject({
    method: "POST",
    headers: { authorization: "Bearer owner-token" },
    body: JSON.stringify(ref),
    redirect: "error",
  });
  expect(init?.signal?.aborted).toBe(false);
  controller.abort();
  expect(init?.signal?.aborted).toBe(true);
});
test.each([() => Response.json({ data: { title: null } })])("only an explicit null title reports a missing owner", async (response) => {
  inspect(response);
  expect(await readCodeResourceOwnerTitle(ref, principal)).toBeNull();
});
test.each([
  () => new Response("unavailable", { status: 503 }),
  () => new Response("not json"),
  () => Response.json({ data: { title: "", granted: true } }),
  () => new Response("x".repeat(CAPABILITY_MAX_RESULT_BYTES + 1)),
])("unavailable or invalid owner replies reject instead of pretending the owner disappeared", async (response) => {
  inspect(response);
  await expect(readCodeResourceOwnerTitle(ref, principal)).rejects.toThrow();
});
