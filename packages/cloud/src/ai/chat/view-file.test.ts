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
  // `view=1` asks Cloud to name the view's references for this reader as it reads the file.
  expect(transport).toHaveBeenCalledWith("/files/orders?view=1", { signal: abort });
});

test("a changed reserved part stays unavailable", async () => {
  spyOn(globalThis, "fetch").mockResolvedValue(response({ ...source, items: [{ label: "Orders", value: 12 }] }));
  expect(await loadView("/files/orders", path, summary, signal())).toBeNull();
});

test("a record's reference named for the reader as the file is read still matches its reserved summary", async () => {
  const written = parseCloudAiView({
    view: "details",
    title: "Auftrag",
    items: [
      { label: "Kunde", type: "text", value: "Galerie Nord" },
      { label: "Aufgabe", type: "ref", value: { type: "spaces.item", id: "task-2" } },
    ],
  });
  if (!written || written.view !== "details") throw new Error("Invalid record fixture");
  const reserved = cloudAiViewSummary(written);
  const named = {
    ...written,
    items: written.items.map((item) =>
      item.type === "ref" ? { ...item, value: { type: "spaces.item", id: "task-2", title: "Rechnung prüfen und freigeben" } } : item,
    ),
  };
  spyOn(globalThis, "fetch").mockResolvedValue(response(named));
  expect(await loadView("/files/orders", path, reserved, signal())).toMatchObject({ block: "details" });
  // A changed text that is not a reference still moves the viewport and stays unavailable.
  spyOn(globalThis, "fetch").mockResolvedValue(
    response({ ...named, items: [{ label: "Kunde", type: "text", value: "Galerie Nord am Hafen" }, named.items[1]] }),
  );
  expect(await loadView("/files/orders", path, reserved, signal())).toBeNull();
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
