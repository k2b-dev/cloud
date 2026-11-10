# MapTile and MapDialog

`MapTile` is a small, still map that is one button. `MapDialog` is the full
map it opens: map and list side by side in a dialog, and on a phone the map on
the whole screen with the list as a sheet. Both know only places, lines, and
links; the host supplies the map, its style, and its credits.

## Use MapTile and MapDialog

Use a tile wherever a map appears inside other content: a chat answer, a note,
a contact's address. The tile shows the map image with a summary pill at the
bottom left, such as `86.4 km · 1 h 32 min · A → B → C → D`, the address of
one place, or `12 places`. It has no zoom, no gestures, and no pin selection,
and it takes exactly the size of its map: no title above, no actions below.
Activating it opens the dialog.

Use `MapView` directly only when the map is the page's main content.

## Import

```tsx
import {
  MAP_DIALOG_PARAM, MapDialog, MapTile, MapView, geoNavigationHref, geoNavigationPlatform, mapDialogOptions,
  type GeoNavigationPlatform, type MapDialogFact, type MapDialogMapView, type MapDialogMenuItem,
  type MapDialogProps, type MapPlace, type MapPlaceLink, type MapPlaceSource, type MapTileProps,
} from "@k2b/ui";
```

## The tile

| Prop | Meaning |
| --- | --- |
| `label` | Accessible name of the whole tile, such as `Open map: Delivery Thursday, 86.4 km, 4 stops`. |
| `summary` | Text in the pill. The pill always ends with the ⤢ icon; on hover the pill turns grey and the icon blue. |
| `loading` | The places are still loading: the pill shows progress and the tile cannot open yet. |
| `dialog` | `(close) => JSX.Element`, normally a `MapDialog`. |
| `restoreId` | A stable id of this map on the page; see [Back and reload](#back-and-reload). |
| `children` | The map in the size of the tile: `MapView` with `still`, or a host wrapper such as Cloud's `CloudMap`. |

`MapView` with `still` loads the map image but has no controls, gestures, pin
selection, or info tile, and its pins are images. Inside a tile, map messages
such as **Map image did not load** with **Try again** and the credits stay
usable above the tile's button. A route summary names the stops in order up
to five, then their number.

## The dialog

`MapDialog` lists `places` and draws a pin for each place with a `point`.
Selection is shared: a list row, a pin, or the arrow keys select a place, and
its details show below the list (on a phone, above it).

| Prop | Meaning |
| --- | --- |
| `title` | Heading of the dialog. |
| `facts` | Large figures under the title, such as distance and driving time. |
| `count` | A chip instead of facts, such as `12 places` or an address label. |
| `places` | `MapPlace[]`, see below. One place shows its details without a list. |
| `lines`, `markers`, `fit` | Route lines, extra pins that are not listed (such as a proposed stop), and the fit mode. |
| `selectedId`, `onSelect` | Optional controlled selection; otherwise the first place. |
| `listLabel`, `group` | Name of the list for assistive technology, and a heading above it. |
| `loading`, `empty` | Loading rows, and the content that replaces an empty list. |
| `map` | `(view) => JSX.Element`: spread `view` (height, padding, markers, lines, selection, own location) onto `MapView` or its host wrapper. |
| `menu` | Actions in the **More actions** menu next to the title. |
| `placeActions` | More buttons next to the navigation link of the selected place. |
| `notice` | Host content above the list, such as a confirmation or a recovery. |
| `provenance` | The source line at the bottom. |
| `onLocation` | Receives the person's location after **Show my location**. |

A `MapPlace` has `id`, `name`, and optionally `point`, `mark`, `tone`,
`subtitle`, `trailing` and `trailingDetail` (the right column of the row),
`address` (with a copy button), `hours`, `note`, `source`, and `links`.
The host fills `note`, `source` (`{ label, icon?, tone? }`; `tone: "ai"`
marks a suggestion that an account without a person made), and `links`
(`{ label, href, icon? }`); the dialog only shows them. Links to other sites
open beside the page; links on the same site open in place; any scheme other
than `http` and `https` is dropped.

Every place gets a navigation link as its first action:
**Open in OpenStreetMap** on a computer, **Open in Apple Maps** on an iPhone or
iPad, and **Open in maps app** (`geo:`) on Android. `geoNavigationHref(target,
platform)` and `geoNavigationPlatform(userAgent)` build the same link for a
host's own buttons; choose the platform after the first render.

On a phone the list is a sheet with three heights: low, half, and nearly full.
Its handle is a button that names the way it goes; a press moves the sheet up
and, from the top, back down. The map fills the screen above the resting
sheet, so its fitted pins are never under the list. A pin picked behind the
low sheet raises it to half height.

## Back and reload

`mapDialogOptions` opens the dialog with a history entry: Back, Escape, the
close button, and a click beside the dialog close it, and focus returns to
the tile. The dialog closes before the person leaves the page, and it closes
when its tile goes away.

With `restoreId`, the dialog's history entry carries `?map=<restoreId>`
(`MAP_DIALOG_PARAM`; dialogCore's `historyUrl`). Back and closing return to
the page address without it. A reload opens the dialog again once the tile has
loaded and resumes the same entry, so one Back still closes it. A link that
already names the map opens it as well; closing then removes the name. Give
`restoreId` only to maps with an id that stays the same across reloads, such
as a saved map or an address; a map that is only a block in a document stays
closed after a reload.

## States

| State | What the person sees |
| --- | --- |
| Loading | Tile: spinner in the pill, not openable. Dialog: loading rows and `—` in the figures. |
| Map image missing | Tile: **Map image did not load** with **Try again**; pins stay. Dialog: pins, list, and navigation stay. |
| Map limit reached | The host's notice on the map, such as Cloud's budget message with its reset time. |
| No places | Tile: the host's summary. Dialog: **No places on this map.** or the host's `empty` content. |
| One place | The dialog shows its details without a list; the map shows its neighbourhood, not a single street. |
| Many places | Pins that would cover each other move apart, as in `MapView`; the list scrolls. |
| Reduced motion | The sheet changes height without a transition; the map camera jumps. |
| Dark | The same layout on dark tokens; the pill keeps a thin light edge. |

## Accessibility

The tile is one button with the host's `label`. Enter or Space opens the
dialog; the dialog's heading names it. The list is a listbox: arrow keys,
Home, and End move the selection, and the map's selected pin follows. The
selected place's details are a polite live region. The close button, the
menu, the sheet handle, and the copy button have inherited English or German
labels. On touch screens every control and action is at least 44 px tall in
the sheet.

## Runtime

Both components need a browser for the map image; the tile renders on the
server with its pins, summary, and name, so the first client render matches.
The dialog opens through `dialogCore`. MapLibre loads only when a map is in
view, as for `MapView`.

## Example

```tsx
const places: MapPlace[] = [
  { id: "a", mark: "A", name: "Warehouse", point: { lat: 48.398, lon: 9.992 }, trailing: "Start" },
  { id: "b", mark: "B", name: "Garden café", point: { lat: 48.403, lon: 9.999 }, trailing: "6 min", trailingDetail: "1.2 km",
    note: "Deliver through the side gate.", links: [{ label: "Open order", href: "/orders/42" }] },
];
const markers = places.map((place) => ({ id: place.id, mark: place.mark, label: place.name, point: place.point! }));

<MapTile label="Open map: Delivery, 1.2 km, 2 stops" summary="1.2 km · 6 min · A → B" restoreId="delivery-42"
  dialog={(close) => (
    <MapDialog title="Delivery" facts={[{ value: "1.2 km", label: "Distance" }, { value: "6 min", label: "Driving time" }]}
      places={places} map={(view) => <MapView {...view} style={styles} attribution="Demo data" />}
      provenance="Demo data" onClose={close} />
  )}>
  <MapView still height={240} style={styles} markers={markers} attribution="Demo data" />
</MapTile>
```
