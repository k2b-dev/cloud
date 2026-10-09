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
import { SignatureInput, signatureToPng, type SignatureValue } from "@k2b/ui";
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
so it takes the text colour when embedded inline and renders black as an
image. A drawn signature keeps the size of the pad it was drawn on and scales
cleanly, for example into a PDF template.

`signatureToPng(value, { scale, color, background })` rasterizes a value into
a PNG data URL in the browser. `scale` defaults to `2` device pixels per SVG
unit, `color` to black, and `background` to transparent.

A drawn value reports through `onValueChange` and `onValueCommit` after each
finished stroke, Undo, and Clear. Typing reports every change through
`onValueChange` and commits when the name field loses focus. Setting the value
to `null` resets the field; setting a stored value shows it again, and a
stored drawing can be extended or undone.

With `name`, a hidden input submits the value as JSON in a native form, or an
empty string without a signature.

## Drawing and typing

Drawing uses pointer events. A pen's pressure changes the line width; for a
finger or mouse, faster movement draws a thinner line. Strokes are smoothed,
the page does not scroll while drawing on a touch screen, and the stroke
continues when the pointer leaves the pad. Undo removes the last stroke and
Clear removes the whole signature.

The Draw and Type switch keeps both inputs. The field reports the one that is
shown, so switching back restores the earlier drawing or name.

Typed names render in an installed handwriting face: Segoe Script on Windows,
Snell Roundhand or Bradley Hand on Apple platforms, Dancing Script on Android,
then the generic `cursive` family. Set `--k2b-font-signature` to use another
installed font. An SVG shown as an image, and therefore `signatureToPng`, can
only use fonts installed on the device, not web fonts of the page.

`allowTyped={false}` hides the Type option. Only use it when the application
offers another accessible way to sign.

## Layout

The pad has one height in both modes and in every state: about a third of the
small viewport height, between `9rem` and `12rem`. Set
`--k2b-signature-height` on the field to choose a different height. Drawing,
typing, switching modes, errors, and disabled states never move the
surrounding page.

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
it saves.

## Accessibility

Typing is the keyboard and screen-reader path: the Draw and Type switch is a
radio group, and the name field has its own accessible name. The drawing pad
is announced as an image that says whether a signature is present. Provide a
visible `label`, or set `"aria-label"` for the group.

## Runtime

Drawing, typing, and `signatureToPng` require hydrated Solid client code.
Server rendering shows a stored value, the empty pad, and the field contract.

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
```
