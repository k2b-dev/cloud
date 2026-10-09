# SignatureInput

`SignatureInput` lets someone sign by drawing with a finger, pen, or mouse, or
by typing their name. The parent owns the value, storage, and any legal or
audit record such as timestamps, hashes, or the signer's identity.

## Use SignatureInput

Use it where a person confirms something with a signature in the browser, such
as a delivery receipt, a handover, or a contract.

Use `TextInput` when only a name is needed. Do not treat the signature image as
proof of identity; record who signed and when in the owning application.

## Import

```tsx
import { parseSignature, SignatureInput, signatureToPng, type SignatureValue } from "@k2b/ui";
```

## Value

The value is `SignatureValue | null`:

```ts
type SignatureValue =
  | { kind: "drawn"; svg: string }
  | { kind: "typed"; name: string; svg: string };
```

`kind` records how the signature was given, so the application can store that
fact with it. `svg` is a standalone SVG document. Its ink uses `currentColor`,
so it renders black as an image. A drawn signature keeps the size of the pad
it was drawn on and scales cleanly, for example into a PDF template. When the
pad changes its shape while someone signs, for example on a rotated phone, the
drawing grows to the whole visible pad, so the SVG keeps all ink the signer
saw.

`signatureToPng(value, { scale, color, background })` rasterizes a value into
a PNG data URL in the browser. `scale` defaults to `2` device pixels per SVG
unit, `color` to black, and `background` to transparent. It throws when the
browser cannot create a canvas of that size; use a smaller `scale` then.

A drawn value reports through `onValueChange` and `onValueCommit` after each
finished stroke, Undo, and Clear. Typing reports every change through
`onValueChange` and commits when the name field loses focus.

A value the application sets replaces both the drawing and the typed name:
`null` resets the field, and a stored value shows it again. A stored drawing
can be extended or undone. A field that already reports `null`, for example
after switching to an empty Type field, receives no new value from a reset,
so the hidden drawing stays. For a new signer, render a new field instead,
for example with a keyed `<Show>`.

With `name`, a hidden input submits the value as JSON in a native form, or an
empty string without a signature.

## Read a submitted signature

A value that reaches the server comes from the browser, so treat it as
untrusted input. `parseSignature(input)` reads the hidden input's JSON string
or a value sent as JSON. It accepts only the markup the field writes and
returns the value rebuilt, or `null` for an empty or invalid value. Store and
embed only that result, and treat `null` like a missing signature:

```ts
// `null`: no signature, or markup the field did not write.
const signature = parseSignature(form.get("signature"));
```

Show a stored signature as an image, for example in an `<img>` with a
`data:image/svg+xml` URL, or in a read-only `SignatureInput`. Embed SVG markup
inline only after `parseSignature` rebuilt it.

## Drawing and typing

Drawing uses pointer events. A pen's pressure changes the line width; for a
finger or mouse, faster movement draws a thinner line. Strokes are smoothed,
the page does not scroll while drawing on a touch screen, and the stroke
continues when the pointer leaves the pad. A read-only or disabled pad lets
the page scroll and zoom as usual.

Only the main contact draws: a mouse's other buttons, a pen's barrel button,
and its eraser do not. A pen takes over from a touch that is still down, such
as a palm resting on a tablet. A stroke is dropped without a value when the
system cancels it, or when the field turns disabled or read-only, receives a
new value, or switches to typing while the stroke is in progress.

Undo removes the last stroke. Clear removes the whole signature, both the
drawing and the typed name, and keeps keyboard focus in the field.

The Draw and Type switch keeps both inputs. The field reports the one that is
shown, so switching back restores the earlier drawing or name.

Typed names render in an installed handwriting face: Segoe Script on Windows,
Snell Roundhand or Bradley Hand on Apple platforms, Dancing Script on Android,
then the generic `cursive` family. Set `--k2b-font-signature` to use another
installed font. An SVG shown as an image, and therefore `signatureToPng`, can
only use fonts installed on the device, not web fonts of the page.

`allowTyped={false}` hides the Type option. Only use it when the application
offers another accessible way to sign. A typed value still shows its name,
which can be cleared but not edited; Clear then returns to drawing.

## Layout

The pad has one height in both modes and in every state: about a third of the
small viewport height, between `9rem` and `12rem`. Set
`--k2b-signature-height` on the field to choose a different height. Drawing,
typing, switching modes, and disabled states keep the pad and toolbar in
place. An error message adds a line below the field, as on other fields.

## API reference

See [shared field props](/en/ui/getting-started#shared-field-props) for labels,
descriptions, errors, `required`, `disabled`, and value accessors.

```ts
type SignatureInputProps = ValueFieldProps<SignatureValue | null> & {
  name?: string;
  readOnly?: boolean;
  allowTyped?: boolean;
};
```

`readOnly` shows the signature with its controls disabled. `required` marks the
field and the name input; the application validates that a value exists before
it saves, on the server with `parseSignature`.

## Accessibility

Typing is the keyboard and screen-reader path: the Draw and Type switch is a
radio group, and the name field has its own accessible name. The drawing pad
is announced as an image that says whether a signature is present. A required
field says so in the group's description. Provide a visible `label`, or set
`"aria-label"` for the group.

## Runtime

Drawing, typing, and `signatureToPng` require hydrated Solid client code.
Server rendering shows a stored value, the empty pad, and the field contract.
`parseSignature` is a pure function for the server and the browser.

## Example

```tsx
const [signature, setSignature] = createSignal<SignatureValue | null>(null);

<SignatureInput
  label="Signature"
  description="Confirms that the items were received."
  required
  value={signature}
  onValueChange={setSignature}
/>;

// Later, when a bitmap is needed:
const current = signature();
const png = current ? await signatureToPng(current, { background: "#ffffff" }) : null;

// On the server, from a native form with name="signature":
const submitted = parseSignature(form.get("signature"));
```
