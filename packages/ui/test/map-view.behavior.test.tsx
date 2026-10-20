import { expect, test } from "bun:test";
import { createSignal } from "solid-js";
import { isServer, render } from "solid-js/web";
import type { MapViewMarker } from "../src/content/map-view-types";
import { createDomTestHarness } from "./dom";

if (isServer) test.skip("requires browser conditions", () => {});
else
  test("refreshing markers preserves the focused pin and updates its label", async () => {
    const dom = createDomTestHarness();
    const { MapView } = await import("../src/content/MapView");
    const [markers, setMarkers] = createSignal<MapViewMarker[]>([
      { id: "a", mark: "A", label: "Start", point: { lat: 48.397, lon: 9.982 } },
      { id: "one", mark: 1, label: "Museum", point: { lat: 48.398, lon: 9.992 } },
    ]);
    const selected: string[] = [];
    const dispose = render(
      () => (
        <MapView
          height={400}
          style={{ version: 8, sources: {}, layers: [] }}
          attribution="Local data"
          markers={markers()}
          onSelect={(id) => selected.push(id)}
        />
      ),
      dom.root,
    );
    try {
      const pin = dom.root.querySelector<HTMLButtonElement>('.k2b-map-view__pin[data-id="a"]')!;
      pin.focus();
      setMarkers(
        markers().map((marker) => ({ ...marker, point: { ...marker.point }, label: marker.id === "a" ? "New start" : marker.label })),
      );
      await Promise.resolve();
      expect(dom.document.activeElement === pin).toBe(true);
      expect(dom.root.querySelector('.k2b-map-view__pin[data-id="a"]') === pin).toBe(true);
      expect(pin.getAttribute("aria-label")).toBe("A New start");

      // Updated marks change the drawing order without replacing the focused pin.
      setMarkers([
        { id: "a", mark: 0, label: "New start", tone: "warning", selected: true, point: { lat: 48.399, lon: 9.981 } },
        { id: "one", mark: 1, label: "Museum", point: { lat: 48.398, lon: 9.992 } },
      ]);
      await Promise.resolve();
      expect(dom.document.activeElement === pin).toBe(true);
      expect(pin.getAttribute("aria-label")).toBe("0 New start");
      expect(pin.textContent).toBe("0");
      expect(pin.dataset.tone).toBe("warning");
      expect(pin.hasAttribute("data-stop")).toBe(false);
      expect(pin.getAttribute("aria-pressed")).toBe("true");
      expect(pin.tabIndex).toBe(0);
      pin.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
      expect(dom.document.activeElement === dom.root.querySelector('.k2b-map-view__pin[data-id="one"]')).toBe(true);
      expect(selected).toEqual(["one"]);
    } finally {
      dispose();
      dom.cleanup();
    }
  });
