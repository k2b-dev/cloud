import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { CLOUD_AI_VIEW_MAX_BYTES, cloudAiViewSummary, parseCloudAiView } from "../view-block";
import { loadView } from "./view-file";

const path = "/views/orders-12345678.view.json";
const source = { view: "stats", title: "Orders", items: [{ label: "Orders", value: 12, delta: 2 }] };
const view = parseCloudAiView(source);
if (!view) throw new Error("Invalid saved view fixture");
const summary = cloudAiViewSummary(view);
const signal = () => new AbortController().signal;
const response = (value: unknown, origin = "assistant") => Response.json(value, { headers: { "X-Cloud-Ai-File-Origin": origin } });
afterEach(() => mock.restore());

test("a saved view becomes a portable description after validation against its reserved summary", async () => {
  const transport = spyOn(globalThis, "fetch").mockResolvedValue(response(source));
  const abort = signal();
  expect(await loadView("/files/orders", path, summary, abort)).toEqual({
    block: "stats",
    title: "Orders",
    items: [{ label: "Orders", value: 12, delta: { value: 2, unit: "absolute", better: undefined, format: undefined } }],
  });
  expect(transport).toHaveBeenCalledWith("/files/orders", { signal: abort });
});

test("a changed reserved part stays unavailable", async () => {
  spyOn(globalThis, "fetch").mockResolvedValue(response({ ...source, items: [{ label: "Orders", value: 12 }] }));
  expect(await loadView("/files/orders", path, summary, signal())).toBeNull();
});

test("origin, file namespace, byte limit and strict data validation survive deferred loading", async () => {
  const transport = spyOn(globalThis, "fetch");
  transport.mockResolvedValue(response(source, "user"));
  expect(await loadView("/files/orders", path, summary, signal())).toBeNull();
  transport.mockResolvedValue(response(source));
  expect(await loadView("/files/orders", "/documents/orders.view.json", summary, signal())).toBeNull();
  transport.mockResolvedValue(
    new Response("x".repeat(CLOUD_AI_VIEW_MAX_BYTES + 1), { headers: { "X-Cloud-Ai-File-Origin": "assistant" } }),
  );
  expect(await loadView("/files/orders", path, summary, signal())).toBeNull();
  transport.mockResolvedValue(response({ ...source, unexpected: true }));
  expect(await loadView("/files/orders", path, summary, signal())).toBeNull();
});

test("a canceled or failed download returns the normal unavailable state", async () => {
  spyOn(globalThis, "fetch").mockRejectedValue(new DOMException("Aborted", "AbortError"));
  expect(await loadView("/files/orders", path, summary, signal())).toBeNull();
});
