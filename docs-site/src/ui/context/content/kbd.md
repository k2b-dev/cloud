# Kbd

`Kbd` shows a shortcut as accessible key caps.

## Use Kbd

Use it in help text, menus, and shortcut lists. Use `formatShortcut` for plain text such as tooltips.

## Import

```tsx
import { Kbd, formatShortcut, keyboardPlatform } from "@k2b/ui";
```

## Example

```tsx
<Kbd keys="mod+k" />
formatShortcut("mod+k", { platform: "apple", locale: "en" }).label; // ⌘K
keyboardPlatform("MacIntel"); // apple
```

## Keyboard hints

Use `class="k2b-kbd-hint"` for an optional shortcut hint, for example in a
toolbar. It reserves its space with `visibility: hidden` and shows after the
first qualifying key press. Typing and lone modifiers do not count. The host
starts `installInputModeController()`; see [Input mode](/en/ui/input-mode).

```tsx
<Kbd keys="mod+k" class="k2b-kbd-hint" />
```

Keep shortcut lists and help visible; do not apply this utility to them.

## Input grammar

Separate modifiers with `+`, then write exactly one key. Modifiers are `mod`,
`ctrl`, `alt`, `shift`, and `meta`. Input ignores case. `mod` means Command on
Apple and Control elsewhere. `mod++` uses the plus key. Repeated modifiers
collapse. Caps follow Control, Alt/Option, Shift, Meta/Command order.
Apple labels have no separator; other labels use `+`.
A literal space key (`" "`, `"ctrl+ "`, or `"mod+shift+ "`) formats as `space`, with the cap "Space" or "Leertaste".

Invalid combinations return `{ keys: [], label: "", name: "" }`.
`Kbd` renders nothing for them. Other key names use an initial capital.

| Key | English cap | German cap | Spoken English / German |
| --- | --- | --- | --- |
| `ctrl` | Ctrl / ⌃ on Apple | Strg / ⌃ on Apple | Control / Steuerung; Apple: Control |
| `alt` | Alt / ⌥ on Apple | Alt / ⌥ on Apple | Alt; Apple: Option / Wahltaste |
| `shift` | Shift / ⇧ on Apple | Umschalt / ⇧ on Apple | Shift / Umschalttaste |
| `meta` | Meta / ⌘ on Apple | Meta / ⌘ on Apple | Meta; Apple: Command / Befehlstaste |
| `arrowup`, `arrowdown`, `arrowleft`, `arrowright` | ↑ ↓ ← → | ↑ ↓ ← → | Up/Down/Left/Right arrow / Pfeil nach oben/unten/links/rechts |
| `enter` | ↵ | ↵ | Enter / Eingabetaste |
| `escape`, `esc` | Esc | Esc | Escape |
| `tab` | Tab | Tab | Tab / Tabulatortaste |
| `space` | Space | Leertaste | Space / Leertaste |
| `backspace` | ⌫ | ⌫ | Backspace / Rücktaste |
| `delete` | Del / ⌦ on Apple | Entf / ⌦ on Apple | Delete / Entfernen |
| `home`, `end` | Home, End | Pos1, Ende | Home, End / Pos 1, Ende |
| `pageup`, `pagedown` | PgUp, PgDn | Bild↑, Bild↓ | Page up, Page down / Bild auf, Bild ab |
| One character; `f1`–`f12` | Uppercase | Uppercase | The cap label |

## Server rendering

When the host knows the reader's platform, pass
`platform={keyboardPlatform(request.headers.get("user-agent") ?? "")}` to
`Kbd`. This keeps server and browser caps identical. Without `platform`,
`Kbd` uses `other` on the server and, in a host that hydrates, during hydration;
caps switch to the detected platform after mount. A browser render that does not
hydrate, such as a client component or an island that renders again, detects it
immediately.

`keyboardPlatform()` without an argument reads the runtime's
`navigator.platform`, then `navigator.userAgent`, including on the server.
Server code passes the request's User-Agent to `keyboardPlatform` or an
explicit `platform` to `formatShortcut`.
`formatShortcut` accepts `{ platform, locale }`; omitted values use platform
detection and the document language, or English on the server.
`Kbd` uses the inherited `LocaleProvider` locale.

## Accessibility

A screen reader hears one spoken shortcut. Visual caps are hidden from it.
`formatShortcut` returns `keys` with `label` and `name`, plus joined `label`
and `name` strings. A spoken shortcut separates names with spaces.

## Runtime

Server caps work without JavaScript. When `platform` is omitted, the component detects the platform in the browser.
