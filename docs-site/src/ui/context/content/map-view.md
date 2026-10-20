# MapView

`MapView` shows places, routes, areas, and your location in a fixed space.
Pins and geometry render on the server. The map image loads when the map
enters the viewport; places remain usable if it fails.

## Import

```tsx
import {
  Button, MapAttribution, MapView, MapViewFrame, mapAttribution, mapPalette, mapStyle,
  type MapPaletteColors, type MapStyleOptions, type MapTheme,
  type MapViewMarker, type MapViewStyleSource,
} from "@k2b/ui";
import { createSignal, For } from "solid-js";
```

## Use MapView

The host owns selection, map styles, and attribution. Supply a style object or
a path served by your application.

## Style

`mapStyle({ theme, locale, tiles, glyphs, maxzoom })` builds a flat light or
dark style for OpenMapTiles-schema vector tiles. Pass both as `{ light, dark }`
to `style`:

```tsx
const templates = {
  tiles: "/_geo/tiles/{z}/{x}/{y}.pbf",
  glyphs: "/_geo/glyphs/{fontstack}/{range}.pbf",
  locale: "de",
};

<MapView height={360} markers={markers}
  style={{
    light: mapStyle({ ...templates, theme: "light" }),
    dark: mapStyle({ ...templates, theme: "dark" }),
  }}
  attribution={<MapAttribution />} />
```

The host passes tile and glyph URL templates as root-relative paths or absolute
URLs. `@k2b/ui` contains no provider endpoint, API key, or network default.
The style has no sprite; pins are DOM markers.

### Palette

The accent belongs to the host's pins and lines. The map image has no
extrusion, relief, or decorative tints: woods, grass, and city green are
tinted, large protected areas are not.

| `mapPalette` key | Light | Dark | CSS token |
| --- | --- | --- | --- |
| `land` | `#f1efe9` | `#1a1f26` | `--k2b-map-land` |
| `green` | `#e3ecd9` | `#1c2a22` | `--k2b-map-green` |
| `water` | `#cfe3f3` | `#14283a` | `--k2b-map-water` |
| `building` | `#e8e5dd` | `#20262e` | `--k2b-map-building` |
| `road` | `#ffffff` | `#2c333d` | `--k2b-map-road` |
| `roadCasing` | `#dcd8ce` | `#222830` | `--k2b-map-road-casing` |
| `motorway` | `#f6c76b` | `#5d6470` | `--k2b-map-motorway` |
| `motorwayCasing` | `#d9a443` | `#444a54` | `--k2b-map-motorway-casing` |
| `rail` | `#c4bfb4` | `#39404a` | `--k2b-map-rail` |
| `boundary` | `#aea89c` | `#4f5763` | `--k2b-map-boundary` |
| `label` | `#52525b` | `#a1a1aa` | `--k2b-map-label` |
| `labelStrong` | `#27272a` | `#e4e4e7` | `--k2b-map-label-strong` |
| `waterLabel` | `#3a6383` | `#8fb5d3` | `--k2b-map-water-label` |

MapLibre cannot read CSS, so the style uses `mapPalette`. The CSS tokens
mirror it for map art drawn by the host, and a test keeps them equal.
Overriding the tokens does not recolour the map image.

### Labels and glyphs

Labels prefer `name:<language>`, then `name:latin`, then `name`.
For example, `de-DE` uses `name:de`. Empty or unrecognised language codes
use `name:latin`, then `name`. Every label uses one fontstack:
`IBM Plex Sans Medium`.

Serve the files from
`@k2b/ui/map-glyphs/IBM Plex Sans Medium/<range>.pbf` at your glyph template.
The `{fontstack}` segment arrives URL-encoded, for example
`IBM%20Plex%20Sans%20Medium`. Answer unknown ranges with **404**: MapLibre
6.14 then draws those characters locally with the browser font. CJK and other
scripts outside the shipped ranges are drawn locally by MapLibre.

The glyphs cover the Latin, Latin Extended, Vietnamese, Greek, and Cyrillic
characters that IBM Plex Sans draws: 9 range files and `OFL.txt`,
**343.7 KiB raw** and **183.3 KiB gzip** at level 6, licence included. A German
or English map usually loads only `0-255` (about 75 KiB raw) and a few small
ranges.

MapLibre draws a character locally only when its whole range is missing. A
shipped range that lacks a character drops it from the label. So ranges where
Plex draws only a character or two (`1280-1535` with Armenian and Hebrew,
`65024-65279`, `65280-65535` with fullwidth forms) are left out and drawn
locally. Shipped ranges still have gaps: Latin Extended Additional
`U+1E00`–`U+1E7F` (for example `ḥ`, `ṣ`, `ḍ`) is not drawn by Plex, and those
letters are dropped.

Regenerate them from the repository root:

```bash
bun packages/ui/scripts/generate-map-glyphs.ts
```

IBM Plex Sans uses the **SIL Open Font License 1.1**. Its licence ships at
`@k2b/ui/map-glyphs/OFL.txt`; serve or keep it with the glyphs.

### Tiles

The vector source has `maxzoom: 14` by default. MapLibre scales level 14 up
for closer zoom levels, which saves tile requests. Pass `maxzoom` when the
tiles carry more detail.

### Attribution

`mapAttribution` and `<MapAttribution />` provide
“© OpenStreetMap · © OpenMapTiles · Geoapify”, each part a link:

| Credit | Link | Duty |
| --- | --- | --- |
| © OpenStreetMap | https://www.openstreetmap.org/copyright | Always required for these maps. |
| © OpenMapTiles | https://openmaptiles.org/ | Required for maps built from its schema under the CC-BY 4.0 design licence. |
| Geoapify | https://www.geoapify.com/ | Kept on paid plans too, so no switch is needed. |

Place the line in MapView's `attribution` slot at the bottom right. On printed
maps, put it next to the image with the URLs written out.

## Example

Keep a map and a host list in sync without a map service:

```tsx
const markers: MapViewMarker[] = [
  { id: "museum", mark: 1, label: "Museum", point: { lat: 48.401, lon: 9.987 } },
  { id: "park", mark: 2, label: "Park", point: { lat: 48.404, lon: 9.995 } },
];
const style: MapViewStyleSource = {
  light: { version: 8, sources: {}, layers: [{ id: "land", type: "background", paint: { "background-color": "#f1efe9" } }] },
  dark: { version: 8, sources: {}, layers: [{ id: "land", type: "background", paint: { "background-color": "#1a1f26" } }] },
};
const [selectedId, setSelectedId] = createSignal("museum");

<MapView height={360} style={style} markers={markers}
  selectedId={selectedId()} onSelect={setSelectedId}
  attribution="Demo data" infoTile={(marker) => <strong>{marker.label}</strong>}
  empty="No places to show" />
<For each={markers}>{(marker) =>
  <Button variant="text" aria-pressed={selectedId() === marker.id}
    onClick={() => setSelectedId(marker.id)}>{marker.label}</Button>
}</For>
```

Use the map provider's required attribution in the `attribution` slot. It
stays visible at the bottom right and shares the bottom row with the scale
bar: a long attribution wraps before it covers the scale. MapView disables MapLibre's attribution
control and displays only this host-supplied content, including when the
style declares its own attribution.

## Props and geometry

| Prop | Meaning |
| --- | --- |
| `height` | Required height in pixels. Width follows the parent. |
| `style` | Required style object or URL, or `{ light, dark }` pair. |
| `attribution` | Required host content; supports links. Optional on `MapViewFrame`. |
| `markers` | `{ id, point: { lat, lon }, label, mark?, tone?, selected? }[]`. Marks are numbers, single letters, or `+`; omit for a drop pin. |
| `lines` | `{ id, points, tone? }[]` or `{ id, polyline6, tone? }[]`. Polyline precision is six decimal places, latitude first. |
| `areas` | `{ id, polygon: { lat, lon }[], tone? }[]`. |
| `ownLocation` | `{ point: { lat, lon }, accuracyMeters? }`; displays a dot and optional accuracy circle. |
| `padding` | Fitting inset in pixels; defaults to `64`, which keeps pins clear of the controls, notice, scale bar, and attribution. Keep height and width larger than twice the padding. |
| `fit` | `all` (default) fits all vertices and location; `markers` fits pins, falling back to all geometry when there are no pins. |
| `selectedId` | Controlled selection; otherwise the first marker with `selected: true` is selected. |
| `onSelect` | Receives a marker ID from a pin click or keyboard selection. |
| `infoTile` | Renders the selected marker at the bottom left above the scale bar. The tile is kept while the selected id stays the same; marker fields read in JSX follow marker refreshes. It lies over the map, so keep it short; a host with its own list can show details there instead. When the tile would cover the selected pin, also after its content grows, the live map moves the pin into the free space above it. |
| `notice` | Host message above the map at the top left. |
| `empty` | Host sentence centered when there is no geometry. |
| `onLocate` | Shows the location button. The host obtains and supplies the location. |
| `class` | Additional root class. |

Marker and area tones are `accent`, `second`, `neutral`, and `warning`.
Line tones are `accent`, `muted`, `preview`, and `previous`. Preview and
previous lines are dashed. Pins appear in number, letter, `+`, then unmarked
order. Pins that would cover each other on a 320 px phone are kept apart at
every width: a numbered pin at a stop sits top right of the stop's letter,
and any other overlapping pin moves to the first free place around its point.
Numbered and drop pins also keep clear of the own-location dot; stops stay on
their route point.
The offsets come from the data alone, so they stay the same when the map image
arrives; once the person zooms, the separation is decided again for the new
scale. Separation is checked for every width from a phone up to the widest fit,
and a dense cluster of pins at one place spreads into rings. Separating 100
pins takes about 12 ms; MapView is meant for the tens of pins a person can
read on one map, not for thousands of points.

Known limits: MapView draws a flat, north-up Mercator map and turns off a
style's globe projection and terrain. Geometry that crosses the antimeridian
is fitted across the longitudes as given, so pins at 179° and −179° sit far
apart. A cluster of many pins at one place on a small map can spread past the
padding; show such places as a list instead. Without a live map (before it
loads, after an error, or without WebGL 2) nothing can move, so a tall info
tile can cover a pin near the bottom left. Filled pins pick a text colour per tone and
theme that keeps 4.5:1 contrast.

The scale bar names the distance for the fitted map: the server frame uses
the widest fit, the browser corrects it for the real width, and after the map
loads it follows the camera.

Until someone moves or zooms the camera, geometry changes and resizing fit
again without animation. A selected pin outside the view is brought into view.
Zoom buttons, selection, and MapLibre's own keyboard, double-click, and drag
gestures respect both the operating system's reduced motion setting and
`data-k2b-motion="reduced"` on `html`: the camera jumps instead of flying or
easing. MapLibre reads the setting when the map starts. Geometry that spans
most of the world never fits further out than the zoom at which the world is
as tall as the map. Near the poles the live camera keeps the fitted center, so
the pins stay where the server put them.

## States in the same space

| State | What the person sees |
| --- | --- |
| `static` | Server geometry and pins; also the first client frame. Zoom is disabled. |
| `loading` | The same geometry with a quiet loading chip. |
| `ready` | Map image under the geometry; zoom and cooperative pan gestures work. |
| `error` | Pins remain, with a message and **Try again**. Also shown when a later style, such as the dark one after a theme switch, does not load. Retry creates a fresh map and requests the style again. When the map code itself did not load, for example on a page that outlived a release, the action is **Reload page** instead, because only a reload fetches the current files. |
| `no-webgl` | The browser has no WebGL 2, which MapLibre 6 needs: pins remain with a capability message, and MapLibre is never downloaded. |
| `empty` | The host's `empty` content; MapLibre never loads. |

The root's `data-state` exposes these states. Image tile errors after the map
has loaded leave the ready map in place. All states keep the requested height.

## Theme and appearance

A style pair follows the nearest `.dark`, `.k2b-dark`, or
`[data-theme="dark"]` ancestor. Theme changes replace the map style in place.
Overlays use the inherited UI tokens in either theme. Hosts can override the
`--k2b-map-*` tokens on their map class, including land, surface, accent,
accent-on, second, second-ink, neutral, warning, me, and line-muted. The
accent defaults to the platform action colour. A host that draws pins in its
own app colour sets `--k2b-map-accent` together with `--k2b-map-accent-ink`
and `--k2b-map-accent-on`, so marks keep 4.5:1 contrast.

## Accessibility

Pins are named buttons in a labelled group. The selected pin, or the first
pin, is the group's tab stop. Arrow keys wrap through pins; Home and End select
the first and last. These keys move focus and call `onSelect`. Pins are keyed by `id`, so a refresh with new marker objects keeps the focused pin. Enter, Space,
and click activate the pin. Keep a visible focus ring and connect selection
to the host list through `selectedId`.

The info tile has a persistent polite live region. Map controls have inherited
English or German labels. MapLibre's canvas supports arrow-key panning; Ctrl
or Command plus scrolling zooms, and two fingers pan on touch devices. When
the canvas has keyboard focus, the whole map shows the focus ring inside its
rounded edge. On touch screens every pin and control has a 44 px hit area; the
zoom buttons keep their tight stack and their hit areas grow outward.

## Server-only frames and PDFs

`MapViewFrame` uses the same geometry, pin visuals, location dot, scale, and
attribution without effects, browser APIs, or map loading:

```tsx
<MapViewFrame height={360} markers={markers} selectedId="museum" attribution="Demo data" />
```

It accepts the geometry, fitting, selection, height, class, and attribution
props above. Its pins are labelled images, not buttons, because nothing can be
selected. It has no live map, controls, status, or info tile.

## Runtime

Bundle the browser application with **Bun**, as `@k2b/ssr` does. MapView's lazy
module uses an import with `type: "file"` to emit its module worker as a `.js`
asset. Serve that asset alongside the JavaScript chunks from the same origin.
MapLibre and its worker stay outside the initial static import closure.

Measured with MapLibre 6.14.0 and Bun 1.4.2 in minified builds, gzip at level 6, in KiB:

| Part | Raw | gzip | Loaded |
| --- | --- | --- | --- |
| MapView in the island (static imports) | 23.5 | 9.2 | with the island |
| MapLibre chunk | 1,006 | 277 | when the map becomes visible |
| MapLibre worker (`map-view-worker-<hash>.js`) | 496 | 143 | when the map becomes visible |
| MapLibre CSS | 0 | 0 | not loaded; `@k2b/ui` styles the few MapLibre elements itself |

A page without a map loads none of these.

For operators, allow `script-src 'self'` and `worker-src 'self'`. No worker
`blob:` permission is needed for this same-origin module worker. Allow the
style, tile, glyph, and sprite origins in `connect-src`; image resources used
directly by the host also need their origins in `img-src`. The server frame
places the fit box, pins, and scale bar with `style` attributes, so the policy
must allow them, for example with `style-src-attr 'unsafe-inline'`; without
that, the server frame shows no geometry until the island renders in the browser.

In MapLibre 6.14, `workerFactory` starts a same-origin URL directly with
`new Worker(url, { type: "module" })`. Its image loader uses
`createImageBitmap` for fetched image data in browsers that support it, so
that path needs no `img-src blob:`. The fallback for browsers without
`createImageBitmap` uses an image element with an object URL and **does** need
`img-src blob:`. The GeoJSON-only demo and browser fixture use no fetched
images, sprites, glyphs, or tiles; their policy requires no image blob access.
