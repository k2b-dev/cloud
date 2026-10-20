# MapView

`MapView` shows places, routes, areas, and your location in a fixed space.
Pins and geometry render on the server. The map image loads when the map
enters the viewport; places remain usable if it fails.

## Import

```tsx
import { Button, MapView, MapViewFrame, type MapViewMarker, type MapViewStyleSource } from "@k2b/ui";
import { createSignal, For } from "solid-js";
```

## Use MapView

The host owns selection, map styles, and attribution. Supply a style object or
a path served by your application.

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
stays visible at the bottom right. MapView disables MapLibre's attribution
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
| `padding` | Fitting inset in pixels; defaults to `48`. Keep height and width larger than twice the padding. |
| `fit` | `all` (default) fits all vertices and location; `markers` fits pins, falling back to all geometry when there are no pins. |
| `selectedId` | Controlled selection; otherwise the first marker with `selected: true` is selected. |
| `onSelect` | Receives a marker ID from a pin click or keyboard selection. |
| `infoTile` | Renders the selected marker at the bottom left above the scale bar. It lies over the map, so keep it short; a host with its own list can show details there instead. |
| `notice` | Host message above the map at the top left. |
| `empty` | Host sentence centered when there is no geometry. |
| `onLocate` | Shows the location button. The host obtains and supplies the location. |
| `class` | Additional root class. |

Marker and area tones are `accent`, `second`, `neutral`, and `warning`.
Line tones are `accent`, `muted`, `preview`, and `previous`. Preview and
previous lines are dashed. Pins appear in number, letter, `+`, then unmarked
order. Pins that would cover each other on a 390 px phone are kept apart at
every width: a numbered pin at a stop sits top right of the stop's letter,
and any other overlapping pin moves to the first free place around its point.
The offsets come from the data alone, so they stay the same when the map image
arrives or the camera changes. Filled pins pick a text colour per tone and
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
| `error` | Pins remain, with a message and **Try again**. Also shown when a later style, such as the dark one after a theme switch, does not load. Retry creates a fresh map and requests the style again. |
| `no-webgl` | Pins remain with a browser capability message. |
| `empty` | The host's `empty` content; MapLibre never loads. |

The root's `data-state` exposes these states. Image tile errors after the map
has loaded leave the ready map in place. All states keep the requested height.

## Theme and appearance

A style pair follows the nearest `.dark`, `.k2b-dark`, or
`[data-theme="dark"]` ancestor. Theme changes replace the map style in place.
Overlays use the inherited UI tokens in either theme. Hosts can override the
`--k2b-map-*` tokens on their map class, including land, surface, accent,
accent-on, second, second-ink, neutral, warning, me, and line-muted.

## Accessibility

Pins are named buttons in a labelled group. The selected pin, or the first
pin, is the group's tab stop. Arrow keys wrap through pins; Home and End select
the first and last. These keys move focus and call `onSelect`. Enter, Space,
and click activate the pin. Keep a visible focus ring and connect selection
to the host list through `selectedId`.

The info tile has a persistent polite live region. Map controls have inherited
English or German labels. MapLibre's canvas supports arrow-key panning; Ctrl
or Command plus scrolling zooms, and two fingers pan on touch devices.

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

Measured with MapLibre 6.15.0, Bun 1.4.2, minified production builds:

| Part | Raw | gzip | Loaded |
| --- | --- | --- | --- |
| MapView in the island (static imports) | 20.6 KB | 7.9 KB | with the island |
| MapLibre chunk | 1,049 KB | 285 KB | when the map becomes visible |
| MapLibre worker (`map-view-worker-<hash>.js`) | 519 KB | 147 KB | when the map becomes visible |
| MapLibre CSS | 0 | 0 | not loaded; `@k2b/ui` styles the few MapLibre elements itself |

A page without a map loads none of these.

For operators, allow `script-src 'self'` and `worker-src 'self'`. No worker
`blob:` permission is needed for this same-origin module worker. Allow the
style, tile, glyph, and sprite origins in `connect-src`; image resources used
directly by the host also need their origins in `img-src`. The server frame
places the fit box, pins, and scale bar with `style` attributes, so the policy
must allow them, for example with `style-src-attr 'unsafe-inline'`; without
that, the server frame shows no geometry until the island renders in the browser.

In MapLibre 6.15, `workerFactory` starts a same-origin URL directly with
`new Worker(url, { type: "module" })`. Its image loader uses
`createImageBitmap` for fetched image data in browsers that support it, so
that path needs no `img-src blob:`. The fallback for browsers without
`createImageBitmap` uses an image element with an object URL and **does** need
`img-src blob:`. The GeoJSON-only demo and browser fixture use no fetched
images, sprites, glyphs, or tiles; their policy requires no image blob access.
