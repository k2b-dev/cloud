import { expect, test } from "bun:test";
import { createSignal, onMount, Show } from "solid-js";
import { isServer, render } from "solid-js/web";
import type { MapViewMarker } from "../src/content/map-view-types";
import { createDomTestHarness } from "./dom";

if (isServer) test.skip("requires browser conditions", () => {});
else {
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

  test("notice, empty and attribution JSX slots are constructed and mounted once", async () => {
    const dom = createDomTestHarness();
    const { MapView } = await import("../src/content/MapView");
    const constructions = { notice: 0, empty: 0, attribution: 0 };
    const mounts = { notice: 0, empty: 0, attribution: 0 };
    const Slot = (props: { name: keyof typeof constructions }) => {
      constructions[props.name]++;
      onMount(() => mounts[props.name]++);
      return <span>{props.name}</span>;
    };
    const dispose = render(
      () => (
        <MapView
          height={400}
          style={{ version: 8, sources: {}, layers: [] }}
          attribution={<Slot name="attribution" />}
          notice={<Slot name="notice" />}
          empty={<Slot name="empty" />}
        />
      ),
      dom.root,
    );
    try {
      expect(constructions).toEqual({ notice: 1, empty: 1, attribution: 1 });
      expect(mounts).toEqual({ notice: 1, empty: 1, attribution: 1 });
      expect(dom.root.querySelector(".k2b-map-view__notice")?.textContent).toBe("notice");
      expect(dom.root.querySelector(".k2b-map-view__empty")?.textContent).toBe("empty");
    } finally {
      dispose();
      dom.cleanup();
    }
  });

  test("an empty reactive notice fragment leaves no blank badge", async () => {
    const dom = createDomTestHarness();
    const { MapView } = await import("../src/content/MapView");
    const [message, setMessage] = createSignal("");
    const dispose = render(
      () => (
        <MapView
          height={160}
          style={{ version: 8, sources: {}, layers: [] }}
          attribution="Local data"
          notice={
            <>
              {undefined}
              <Show when={message()}>{message()}</Show>
            </>
          }
        />
      ),
      dom.root,
    );
    try {
      expect(dom.root.querySelector(".k2b-map-view__notice")).toBeNull();
      setMessage("Map unavailable");
      expect(dom.root.querySelector(".k2b-map-view__notice")?.textContent).toBe("Map unavailable");
      setMessage("");
      expect(dom.root.querySelector(".k2b-map-view__notice")).toBeNull();
    } finally {
      dispose();
      dom.cleanup();
    }
  });

  test("refreshing the selected marker preserves the info tile and its focus until another id is selected", async () => {
    const dom = createDomTestHarness();
    const { MapView } = await import("../src/content/MapView");
    const [markers, setMarkers] = createSignal<MapViewMarker[]>([
      { id: "a", mark: "A", label: "Start", point: { lat: 48.397, lon: 9.982 } },
      { id: "one", mark: 1, label: "Museum", point: { lat: 48.398, lon: 9.992 } },
    ]);
    const [selectedId, setSelectedId] = createSignal<string | undefined>("a");
    const tiles: MapViewMarker[] = [];
    const dispose = render(
      () => (
        <MapView
          height={400}
          style={{ version: 8, sources: {}, layers: [] }}
          attribution="Local data"
          markers={markers()}
          selectedId={selectedId()}
          onSelect={setSelectedId}
          infoTile={(marker) => {
            tiles.push(marker);
            return <button type="button">{marker.label}</button>;
          }}
        />
      ),
      dom.root,
    );
    try {
      const button = dom.root.querySelector<HTMLButtonElement>(".k2b-map-view__info button")!;
      expect(button.textContent).toBe("Start");
      expect(tiles).toHaveLength(1);
      button.focus();
      setMarkers([
        { id: "a", mark: 0, label: "New start", tone: "warning", selected: true, point: { lat: 48.399, lon: 9.981 } },
        { ...markers()[1]!, point: { ...markers()[1]!.point } },
      ]);
      await Promise.resolve();
      expect(dom.document.activeElement === button).toBe(true);
      expect(dom.root.querySelector(".k2b-map-view__info button") === button).toBe(true);
      expect(button.textContent).toBe("New start");
      expect(tiles).toHaveLength(1);
      expect(tiles[0]).toEqual(markers()[0]);

      dom.root.querySelector<HTMLButtonElement>('.k2b-map-view__pin[data-id="one"]')!.click();
      await Promise.resolve();
      const nextButton = dom.root.querySelector<HTMLButtonElement>(".k2b-map-view__info button")!;
      expect(nextButton === button).toBe(false);
      expect(button.isConnected).toBe(false);
      expect(nextButton.textContent).toBe("Museum");
      expect(tiles).toHaveLength(2);
      expect(tiles[1] === tiles[0]).toBe(false);
      expect(tiles[1]).toEqual(markers()[1]);
    } finally {
      dispose();
      dom.cleanup();
    }
  });
}
