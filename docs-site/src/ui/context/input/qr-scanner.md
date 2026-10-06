# QrScanner

`QrScanner` scans a QR code with the rear camera. The host decides whether a
decoded text is acceptable; the scanner stops on an accepted code and marks
the frame red for a rejected one. Camera images stay on the device.

## Import

```tsx
import { QrScanner, type QrScannerError } from "@k2b/ui";
```

## Use QrScanner

Mount the scanner when the person chooses to scan, and unmount it to stop the
camera. Always offer another way in, such as pasting a link, and say why the
camera could not start. The messages come from the application's catalog:

```tsx
const cameraMessages: Record<QrScannerError, string> = {
  denied: "Camera access is off. Allow it in the settings, or paste the link instead.",
  "no-camera": "No camera was found. Paste the link instead.",
  "in-use": "The camera is busy or could not start. Close other apps that use it and try again, or paste the link instead.",
  unavailable: "The camera could not start. Paste the link instead.",
};

<Show when={scanning()} fallback={<Button onClick={() => setScanning(true)}>Scan code</Button>}>
  <QrScanner
    instructions="Point the camera at the pairing code."
    onResult={(text) => {
      const link = parsePairingLink(text);
      if (!link) return false;
      setScanning(false);
      pair(link);
      return true;
    }}
    onStop={() => setScanning(false)}
    onError={(reason) => {
      setScanning(false);
      showPasteField(cameraMessages[reason]);
    }}
  />
</Show>
```

- `onResult(text)` receives untrusted text. Return `true` to accept it, which
  stops the camera, or `false` to reject it and keep scanning. The same
  rejected code is reported again only after a second without any code.
- `onStop()` asks the host to unmount the scanner when the page is hidden or
  left.
- `onError(reason)` reports that the camera or the scanning engine could not
  start, with the reason the browser gives: `"denied"` when camera access is
  off, `"no-camera"` when no camera was found, `"in-use"` when the camera is
  busy or could not start, most often because another app holds it, and
  `"unavailable"` for anything else, such as a page without a secure context or
  a scanning engine that does not load. Show a message for each reason next to
  the other way in. The scanner has already stopped, and it reports nothing
  after it unmounts.
- A frame that cannot be decoded never ends the session or reaches `onError`:
  the camera keeps running until a code is accepted or the host unmounts it.
- `instructions` replaces the generic hint shown while the camera runs.

Each mount owns one camera session. Unmounting stops the camera at once, even
while the browser still asks for permission, and no further camera request
follows. The scanner asks for the rear camera first, then for any camera, and
tries a smaller size when a request fails. It never asks again after a refusal,
so the permission prompt appears at most once.

## Accessibility

The live preview is a labelled video without audio. A status line announces
"Starting camera…" and then the instructions. Scanning cannot be the only way
to continue: keep a text field or a link next to it, and move focus there after
`onError`. The scan frame does not animate under `prefers-reduced-motion`.

## Runtime

The scanner needs the browser, a secure context, and a camera. The scanning
engine ([qr-scanner](https://github.com/nimiq/qr-scanner)) loads only when a
scanner mounts. It uses the browser's own barcode detector where one exists,
such as Chrome on Android, and a bundled decoder elsewhere, such as Safari. When
the browser's detector fails instead of reading, the scanner switches to the
bundled decoder for the page and keeps scanning. The bundled decoder runs as a
worker from a `blob:` address, so a page with a Content Security Policy must
allow it, for example with `worker-src blob:`; otherwise the scanner cannot read
codes. Decoded content and camera frames are never logged.

## Example

```tsx
function ScanPairing() {
  const [scanning, setScanning] = createSignal(false);
  return (
    <Show when={scanning()} fallback={<Button onClick={() => setScanning(true)}>Scan code</Button>}>
      <QrScanner
        onResult={(text) => text.startsWith("https://cloud.example/pair#")}
        onStop={() => setScanning(false)}
        onError={() => setScanning(false)}
      />
    </Show>
  );
}
```
