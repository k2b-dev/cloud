import type {
  DataDrivenPropertyValueSpecification,
  ExpressionSpecification,
  FilterSpecification,
  LayerSpecification,
  StyleSpecification,
} from "maplibre-gl";
import { type MapPaletteColors, type MapTheme, mapPalette } from "./map-palette";

export type MapStyleOptions = {
  theme: MapTheme;
  /** Request locale such as `de` or `de-DE`; labels prefer `name:<language>`. */
  locale: string;
  /** Vector tile template with `{z}`, `{x}`, and `{y}`, for example `/_geo/tiles/{z}/{x}/{y}.pbf`. */
  tiles: string;
  /** Glyph template with `{fontstack}` and `{range}`, served from `@k2b/ui/map-glyphs/*`. */
  glyphs: string;
  /** Highest zoom the tiles carry; the map scales the last level up beyond it. Defaults to 14. */
  maxzoom?: number;
};

/** Attribution for OpenMapTiles-schema maps with OpenStreetMap data from Geoapify, in display order. */
export const mapAttribution = [
  { label: "© OpenStreetMap", href: "https://www.openstreetmap.org/copyright" },
  { label: "© OpenMapTiles", href: "https://openmaptiles.org/" },
  { label: "Geoapify", href: "https://www.geoapify.com/" },
] as const;

const source = "openmaptiles";
/** One weight keeps the glyph assets small; size and ink carry the label hierarchy. */
const font = ["IBM Plex Sans Medium"];
type Stops = readonly (readonly [zoom: number, value: number])[];

const zoomed = (stops: Stops, base = 1.5): ExpressionSpecification =>
  ["interpolate", ["exponential", base], ["zoom"], ...stops.flat()] as ExpressionSpecification;
const linear = (stops: Stops): ExpressionSpecification => ["interpolate", ["linear"], ["zoom"], ...stops.flat()] as ExpressionSpecification;
/** A casing is the fill plus a fixed edge at every stop, because zoom must stay the outer expression. */
const widened = (stops: Stops, edge: number): Stops => stops.map(([zoom, width]) => [zoom, width + edge] as const);
const classIn = (...classes: string[]): ExpressionSpecification => ["in", ["get", "class"], ["literal", classes]];
const notTunnel: ExpressionSpecification = ["!=", ["get", "brunnel"], "tunnel"];
const tunnelOpacity: DataDrivenPropertyValueSpecification<number> = ["match", ["get", "brunnel"], "tunnel", 0.5, 1];

const motorwayWidth: Stops = [
  [5, 0.5],
  [10, 1.5],
  [14, 4],
  [18, 16],
];
const majorWidth: Stops = [
  [8, 0.5],
  [12, 1.5],
  [14, 3.5],
  [18, 14],
];
const secondaryWidth: Stops = [
  [10, 0.5],
  [13, 1.5],
  [14, 2.5],
  [18, 12],
];
const minorWidth: Stops = [
  [13, 0.75],
  [15, 2.5],
  [18, 9],
];
// OpenMapTiles files pedestrian streets as paths; they read as streets, so they get the minor road look.
// Pedestrian squares arrive as polygons and stay plain land.
const minorFilter: FilterSpecification = [
  "any",
  classIn("minor", "service"),
  ["all", ["==", ["get", "class"], "path"], ["==", ["get", "subclass"], "pedestrian"], ["==", ["geometry-type"], "LineString"]],
];

/** `name:<language>`, then the Latin form, then the local name, so a bounded set of glyph ranges covers every label. */
const labelText = (locale: string): ExpressionSpecification => {
  const language = locale.trim().toLowerCase().split(/[-_]/)[0] ?? "";
  const names: ExpressionSpecification[] = [
    ["get", "name:latin"],
    ["get", "name"],
  ];
  if (/^[a-z]{2,3}$/.test(language)) names.unshift(["get", `name:${language}`]);
  return ["coalesce", ...names];
};

const roads = (theme: MapTheme, colors: MapPaletteColors): LayerSpecification[] => {
  const casing = (id: string, filter: FilterSpecification, stops: Stops, minzoom: number, color: string): LayerSpecification => ({
    id: `${id}-casing`,
    type: "line",
    source,
    "source-layer": "transportation",
    minzoom,
    filter,
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": color, "line-width": zoomed(widened(stops, 1.5)), "line-opacity": tunnelOpacity },
  });
  const fill = (
    id: string,
    filter: FilterSpecification,
    stops: Stops,
    minzoom: number,
    color: string | ExpressionSpecification,
  ): LayerSpecification => ({
    id,
    type: "line",
    source,
    "source-layer": "transportation",
    minzoom,
    filter,
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": color, "line-width": zoomed(stops), "line-opacity": tunnelOpacity },
  });
  // Far out, roads take whichever tone stands out more from land: on light land a white road disappears, so it
  // starts in the casing tone; on dark land the casing tone is the weaker one. Edges appear as roads widen.
  const far = theme === "light" ? colors.roadCasing : colors.road;
  const road: ExpressionSpecification = ["interpolate", ["linear"], ["zoom"], 11, far, 12.5, colors.road];
  return [
    {
      id: "path",
      type: "line",
      source,
      "source-layer": "transportation",
      minzoom: 15,
      filter: ["all", classIn("path", "track"), ["!=", ["get", "subclass"], "pedestrian"], notTunnel],
      paint: {
        "line-color": colors.rail,
        "line-width": zoomed([
          [15, 0.75],
          [18, 1.5],
        ]),
        "line-dasharray": [2, 1.5],
      },
    },
    {
      id: "rail",
      type: "line",
      source,
      "source-layer": "transportation",
      minzoom: 11,
      filter: ["all", classIn("rail", "transit"), notTunnel],
      paint: {
        "line-color": colors.rail,
        "line-width": zoomed([
          [11, 0.75],
          [18, 2],
        ]),
      },
    },
    casing("road-minor", minorFilter, minorWidth, 14, colors.roadCasing),
    casing("road-secondary", classIn("secondary", "tertiary"), secondaryWidth, 12, colors.roadCasing),
    casing("road-major", classIn("trunk", "primary"), majorWidth, 12, colors.roadCasing),
    casing("road-motorway", classIn("motorway"), motorwayWidth, 9, colors.motorwayCasing),
    fill("road-minor", minorFilter, minorWidth, 13, road),
    fill("road-secondary", classIn("secondary", "tertiary"), secondaryWidth, 10, road),
    fill("road-major", classIn("trunk", "primary"), majorWidth, 8, road),
    fill("road-motorway", classIn("motorway"), motorwayWidth, 5, colors.motorway),
  ];
};

const labels = (colors: MapPaletteColors, text: ExpressionSpecification): LayerSpecification[] => {
  const paint = (color: string, halo = colors.land) => ({
    "text-color": color,
    "text-halo-color": halo,
    "text-halo-width": 1.5,
  });
  const place = (id: string, classes: string[], minzoom: number, maxzoom: number, size: Stops, color: string): LayerSpecification => ({
    id: `place-${id}`,
    type: "symbol",
    source,
    "source-layer": "place",
    minzoom,
    maxzoom,
    filter: classIn(...classes),
    layout: {
      "text-field": text,
      "text-font": font,
      "text-size": linear(size),
      "text-max-width": 8,
      "symbol-sort-key": ["coalesce", ["get", "rank"], 99],
    },
    paint: paint(color),
  });
  return [
    {
      id: "waterway-label",
      type: "symbol",
      source,
      "source-layer": "waterway",
      minzoom: 13,
      filter: classIn("river", "canal"),
      layout: {
        "text-field": text,
        "text-font": font,
        "text-size": 11,
        "symbol-placement": "line",
        "text-letter-spacing": 0.05,
      },
      paint: paint(colors.waterLabel, colors.water),
    },
    {
      id: "water-name",
      type: "symbol",
      source,
      "source-layer": "water_name",
      filter: ["==", ["geometry-type"], "Point"],
      layout: {
        "text-field": text,
        "text-font": font,
        "text-size": linear([
          [4, 11],
          [12, 13],
        ]),
        "text-max-width": 7,
      },
      paint: paint(colors.waterLabel, colors.water),
    },
    {
      id: "street-label",
      type: "symbol",
      source,
      "source-layer": "transportation_name",
      minzoom: 13,
      filter: classIn("motorway", "trunk", "primary", "secondary", "tertiary", "minor", "service"),
      layout: {
        "text-field": text,
        "text-font": font,
        "text-size": linear([
          [13, 11],
          [18, 13],
        ]),
        "symbol-placement": "line",
        "text-max-angle": 30,
      },
      paint: paint(colors.label, colors.road),
    },
    place(
      "minor",
      ["suburb", "quarter", "neighbourhood", "hamlet", "locality", "isolated_dwelling"],
      12,
      18,
      [
        [12, 11],
        [16, 12.5],
      ],
      colors.label,
    ),
    place(
      "village",
      ["village"],
      10,
      17,
      [
        [10, 11.5],
        [14, 13],
      ],
      colors.label,
    ),
    place(
      "town",
      ["town"],
      7,
      16,
      [
        [7, 11.5],
        [10, 13],
        [14, 15],
      ],
      colors.labelStrong,
    ),
    place(
      "city",
      ["city"],
      4,
      15,
      [
        [4, 12],
        [8, 15],
        [12, 18],
      ],
      colors.labelStrong,
    ),
    place(
      "state",
      ["state", "province"],
      4,
      8,
      [
        [4, 11],
        [7, 12],
      ],
      colors.label,
    ),
    place(
      "country",
      ["country"],
      1,
      7,
      [
        [1, 11],
        [6, 15],
      ],
      colors.labelStrong,
    ),
  ];
};

/**
 * A flat Cloud map style for OpenMapTiles-schema vector tiles. The host passes the tile and glyph
 * templates; there are no network defaults, sprites, extrusions, or relief.
 */
export function mapStyle(options: MapStyleOptions): StyleSpecification {
  const { theme, locale, tiles, glyphs, maxzoom = 14 } = options;
  if (!["{z}", "{x}", "{y}"].every((token) => tiles.includes(token))) throw new TypeError("mapStyle: tiles needs {z}, {x}, and {y}");
  if (!["{fontstack}", "{range}"].every((token) => glyphs.includes(token)))
    throw new TypeError("mapStyle: glyphs needs {fontstack} and {range}");
  if (!Number.isInteger(maxzoom) || maxzoom < 0 || maxzoom > 24) throw new RangeError("mapStyle: maxzoom must be an integer from 0 to 24");
  const colors = mapPalette[theme];
  const text = labelText(locale);
  // Protected areas (the park layer) cover whole regions, so only woods, grass, and city green are tinted.
  const green = (id: string, sourceLayer: string, filter: FilterSpecification): LayerSpecification => ({
    id,
    type: "fill",
    source,
    "source-layer": sourceLayer,
    filter,
    paint: { "fill-color": colors.green },
  });
  return {
    version: 8,
    name: `Cloud ${theme}`,
    glyphs,
    sources: { [source]: { type: "vector", tiles: [tiles], minzoom: 0, maxzoom } },
    layers: [
      { id: "land", type: "background", paint: { "background-color": colors.land } },
      green("landcover-green", "landcover", classIn("wood", "grass")),
      green("landuse-green", "landuse", classIn("cemetery", "pitch", "playground")),
      {
        id: "water",
        type: "fill",
        source,
        "source-layer": "water",
        filter: notTunnel,
        paint: { "fill-color": colors.water },
      },
      {
        id: "waterway",
        type: "line",
        source,
        "source-layer": "waterway",
        minzoom: 8,
        filter: ["all", notTunnel, ["!=", ["get", "intermittent"], 1]],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": colors.water,
          "line-width": [
            "interpolate",
            ["exponential", 1.4],
            ["zoom"],
            8,
            ["match", ["get", "class"], "river", 0.75, 0],
            13,
            ["match", ["get", "class"], "river", 2.5, "canal", 1.5, 0.75],
            18,
            ["match", ["get", "class"], "river", 8, "canal", 5, 2.5],
          ],
        },
      },
      {
        id: "building",
        type: "fill",
        source,
        "source-layer": "building",
        minzoom: 13,
        paint: {
          "fill-color": colors.building,
          "fill-opacity": linear([
            [13, 0],
            [14, 1],
          ]),
        },
      },
      {
        id: "boundary-state",
        type: "line",
        source,
        "source-layer": "boundary",
        minzoom: 4,
        filter: ["all", ["==", ["get", "admin_level"], 4], ["!=", ["get", "maritime"], 1]],
        paint: { "line-color": colors.boundary, "line-width": 0.75, "line-dasharray": [3, 2] },
      },
      {
        id: "boundary-country",
        type: "line",
        source,
        "source-layer": "boundary",
        filter: ["all", ["==", ["get", "admin_level"], 2], ["!=", ["get", "maritime"], 1]],
        paint: {
          "line-color": colors.boundary,
          "line-width": zoomed([
            [2, 0.75],
            [10, 1.5],
          ]),
        },
      },
      ...roads(theme, colors),
      ...labels(colors, text),
    ],
  };
}
