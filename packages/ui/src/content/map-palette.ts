/** The map image colours. Each key is also the CSS token `--k2b-map-<kebab-key>` on `.k2b-map-view`. */
export type MapPaletteColors = {
  /** Background land, also behind the server frame before the map image arrives. */
  land: string;
  /** Woods, grass, parks, and protected areas. */
  green: string;
  water: string;
  building: string;
  road: string;
  roadCasing: string;
  motorway: string;
  motorwayCasing: string;
  /** Rail lines and footpaths. */
  rail: string;
  boundary: string;
  /** Streets, suburbs, villages, and states. */
  label: string;
  /** Cities, towns, and countries. */
  labelStrong: string;
  waterLabel: string;
};
export type MapTheme = "light" | "dark";

/**
 * Plain data so a server can build the style JSON without CSS. The accent stays with the host's
 * pins and lines; the map image only uses calm land, water, green, and road tones.
 */
export const mapPalette = {
  light: {
    land: "#f1efe9",
    green: "#e3ecd9",
    water: "#cfe3f3",
    building: "#e8e5dd",
    road: "#ffffff",
    roadCasing: "#dcd8ce",
    motorway: "#f6c76b",
    motorwayCasing: "#d9a443",
    rail: "#c4bfb4",
    boundary: "#aea89c",
    label: "#52525b",
    labelStrong: "#27272a",
    waterLabel: "#3f6a8a",
  },
  dark: {
    land: "#1a1f26",
    green: "#1c2a22",
    water: "#14283a",
    building: "#20262e",
    road: "#2c333d",
    roadCasing: "#222830",
    motorway: "#5d6470",
    motorwayCasing: "#444a54",
    rail: "#39404a",
    boundary: "#4f5763",
    label: "#a1a1aa",
    labelStrong: "#e4e4e7",
    waterLabel: "#8fb5d3",
  },
} as const satisfies Record<MapTheme, MapPaletteColors>;
