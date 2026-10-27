import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import { staticImportClosure } from "../../../../scripts/fixtures/island-closure";

const root = mkdtempSync(resolve(tmpdir(), "cloud-url-browser-tests-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { cloudOrigin, resolveCloudUrl } = await import("./resource-links");

const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
let shell: string | null;
let requests: { url: string; init?: RequestInit }[];
let response: Response;
let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;
beforeEach(() => {
  shell = JSON.stringify({ cloudOrigin: "https://cloud.example" });
  requests = [];
  response = Response.json({ ref: { type: "demo.item", id: "id" }, title: "Item", href: "/app/demo/id" });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      getElementById: (id: string) => (id === "cloud-shell-data" && shell ? { textContent: shell } : null),
    },
  });
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        requests.push({ url: String(input), init });
        return response;
      },
      { preconnect: fetch.preconnect },
    ),
  );
});
afterEach(() => {
  fetchSpy.mockRestore();
  if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
  else Reflect.deleteProperty(globalThis, "document");
});

test("reads the canonical origin afresh after shell page replacement, and handles missing shell data", () => {
  expect(cloudOrigin()).toBe("https://cloud.example");
  shell = JSON.stringify({ cloudOrigin: "https://new.example" });
  expect(cloudOrigin()).toBe("https://new.example");
  shell = "{}";
  expect(cloudOrigin()).toBeNull();
  shell = null;
  expect(cloudOrigin()).toBeNull();
});

test.each([
  "Words around /app/demo/id",
  "https://other.example/app/demo/id",
  "//cloud.example/app/demo/id",
  "javascript:alert(1)",
  "https://cloud.example/a https://cloud.example/b",
  "a".repeat(8193),
])("does not POST unsupported clipboard text", async (text) => {
  expect(await resolveCloudUrl(text)).toBeNull();
  expect(requests).toHaveLength(0);
});

test.each([" /app/demo/id\n", "https://cloud.example/app/demo/id"])(
  "trims one URL token and sends a cancellable read-only POST",
  async (text) => {
    const controller = new AbortController();
    const result = await resolveCloudUrl(text, { signal: controller.signal });
    expect(result?.ref).toEqual({ type: "demo.item", id: "id" });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("/api/resources/resolve");
    expect(requests[0]?.init?.method).toBe("POST");
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({ url: text.trim() });
    expect(requests[0]?.init?.signal).toBe(controller.signal);
  },
);

test("returns null for unreadable, unavailable and invalid responses", async () => {
  for (const invalid of [
    new Response("private", { status: 404 }),
    new Response("private", { status: 500 }),
    new Response("invalid JSON"),
    Response.json({ ref: {} }),
  ]) {
    response = invalid;
    expect(await resolveCloudUrl("/app/demo/id")).toBeNull();
  }
  fetchSpy.mockRejectedValue(new Error("network failure"));
  expect(await resolveCloudUrl("/app/demo/id")).toBeNull();
});

test("root-relative links still work without configured shell origin; absolute links require it", async () => {
  shell = "{}";
  expect(await resolveCloudUrl("https://cloud.example/app/demo/id")).toBeNull();
  expect(requests).toHaveLength(0);
  expect(await resolveCloudUrl("/app/demo/id")).not.toBeNull();
});

test("resource URL browser helpers keep Zod out of static imports", async () => {
  const closure = await staticImportClosure([resolve(import.meta.dir, "resource-links.ts")]);
  expect(closure.filter((path) => path.includes("node_modules/zod"))).toEqual([]);
}, 30_000);
