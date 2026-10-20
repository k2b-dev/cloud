import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import type { MapViewProps } from "./map-view-types";

const root = mkdtempSync(resolve(tmpdir(), "k2b-map-render-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { MapView } = await import("./MapView");
const { MapViewFrame } = await import("./MapViewFrame");
const { LocaleProvider } = await import("../intl/locale");
const props: MapViewProps = {
  height: 400,
  style: { version: 8, sources: {}, layers: [] },
  attribution: "Local data",
  markers: [
    { id: "a", mark: "A", point: { lat: 48.4, lon: 10 }, label: "Start" },
    { id: "two", mark: 2, point: { lat: 48.41, lon: 10.01 }, label: "Park" },
    { id: "one", mark: 1, point: { lat: 48.42, lon: 10.02 }, label: "Museum" },
  ],
  lines: [
    {
      id: "route",
      points: [
        { lat: 48.4, lon: 10 },
        { lat: 48.42, lon: 10.02 },
      ],
    },
  ],
};
const render = (overrides: Partial<MapViewProps> = {}, locale = "en") =>
  renderToString(() =>
    createComponent(LocaleProvider, {
      locale,
      get children() {
        return createComponent(MapView, { ...props, ...overrides });
      },
    }),
  );
const geometry = (html: string) => html.slice(html.indexOf('<div class="k2b-map-view__fit"'), html.indexOf("</svg>"));
const pinPlaces = (html: string) => Array.from(html.matchAll(/class="k2b-map-view__pin"[^>]*?style="([^"]*)"/g), (match) => match[1]);
describe("MapView server frame", () => {
  test("renders fixed geometry, named ordered pin buttons and disabled zoom controls", () => {
    const html = render();
    expect(html).toContain('class="k2b-map-view" style="height:400px" data-state="static"');
    expect(html).toContain('aria-label="Map"');
    expect(html).toContain("Map with 3 places");
    expect(html).toContain('class="k2b-map-view__fit"');
    expect(html).toContain("aspect-ratio:");
    expect(html).toContain("<svg");
    expect(html).toContain('vector-effect="non-scaling-stroke"');
    expect(html.indexOf('aria-label="1 Museum"')).toBeLessThan(html.indexOf('aria-label="2 Park"'));
    expect(html.indexOf('aria-label="2 Park"')).toBeLessThan(html.indexOf('aria-label="A Start"'));
    expect(html.match(/<button[^>]*disabled[^>]*>/g)?.length).toBe(2);
    expect(html).toContain('aria-label="Places on the map"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain("Local data");
    expect(html.toLowerCase()).not.toContain("maplibre");
  });
  test("standalone PDF frame uses the same geometry markup", () => {
    const frame = renderToString(() => createComponent(MapViewFrame, props));
    expect(geometry(frame)).toBe(geometry(render()));
    expect(pinPlaces(frame)).toHaveLength(3);
    expect(pinPlaces(frame)).toEqual(pinPlaces(render()));
    expect(frame).not.toContain("<button");
    expect(frame).toContain('role="img" aria-label="1 Museum"');
    expect(frame).not.toContain("k2b-map-view__live");
    expect(frame).not.toContain("k2b-map-view__controls");
  });
  test("renders areas, encoded routes, accuracy and an unmarked pin with fallback selection", () => {
    const html = renderToString(() =>
      createComponent(MapViewFrame, {
        height: 400,
        markers: [{ id: "contact", label: "Contact", point: { lat: 38.5, lon: -120.2 }, selected: true }],
        lines: [{ id: "encoded", polyline6: "_izlhA~rlgdF_{geC~ywl@_kwzCn`{nI", tone: "preview" }],
        areas: [
          {
            id: "district",
            polygon: [
              { lat: 38.5, lon: -120.2 },
              { lat: 38.6, lon: -120.1 },
              { lat: 38.7, lon: -120.3 },
            ],
            tone: "warning",
          },
        ],
        ownLocation: { point: { lat: 38.6, lon: -120.1 }, accuracyMeters: 50 },
      }),
    );
    expect(html).toContain('class="k2b-map-view__area" data-tone="warning"');
    expect(html).toContain('class="k2b-map-view__line" data-tone="preview"');
    expect(html).toContain('class="k2b-map-view__accuracy"');
    expect(html).toContain('aria-label="Your location"');
    expect(html).toContain("data-drop");
    expect(html).toMatch(/data-selected[^>]*role="img" aria-label="Contact"/);
  });
  test("empty geometry keeps its height and host sentence without a fit box", () => {
    const html = render({ markers: [], lines: [], empty: "Choose a place" });
    expect(html).toContain("Choose a place");
    expect(html).toContain("height:400px");
    expect(html).not.toContain('class="k2b-map-view__fit"');
    expect(html).toContain('data-state="static"');
  });
  test("resolves German messages and controlled selection on the server", () => {
    const html = render(
      { selectedId: "two", onLocate() {}, ownLocation: { point: { lat: 48.4, lon: 10 } }, infoTile: (marker) => marker.label },
      "de",
    );
    for (const label of ["Karte", "Orte auf der Karte", "Dein Standort", "Ich bin hier", "Vergrößern"])
      expect(html).toContain(`aria-label="${label}"`);
    expect(html).toContain("Karte mit 3 Orten");
    expect(html).toMatch(/aria-label="2 Park" aria-pressed="true" tabindex="0"/);
    expect(html).toContain('aria-live="polite">Park');
    expect(render({ markers: [props.markers![0]!], lines: [] }, "de")).toContain("Karte mit 1 Ort");
  });
});
