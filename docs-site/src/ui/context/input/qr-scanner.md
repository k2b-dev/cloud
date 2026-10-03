# QrScanner

`QrScanner` scans a QR code with the rear camera. The host decides whether a
decoded text is acceptable; the scanner stops on an accepted code and marks
the frame red for a rejected one. Camera images stay on the device.

## Import

```tsx
import { QrScanner } from "@k2b/ui";
```

## Use QrScanner

Mount the scanner when the person chooses to scan, and unmount it to stop the
camera. Always offer another way in, such as pasting a link:

```tsx
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
      showPasteField(reason === "denied" ? "Camera access is off." : "The camera could not start.");
    }}
  />
</Show>
```

- `onResult(text)` receives untrusted text. Return `true` to accept it, which
  stops the camera, or `false` to reject it and keep scanning. The same
  rejected code is reported again only after a second without any code.
- `onStop()` asks the host to unmount the scanner when the page is hidden or
  left.
- `onError(reason)` reports that the camera could not start or failed:
  `"denied"` when the browser reports the camera permission as denied through
  the Permissions API (Safari and Chrome do), `"unavailable"` otherwise. A
  browser that does not report it, or still reports "prompt" after a refusal,
  gives `"unavailable"`, so word the fallback to fit both reasons. The scanner
  has already stopped, and it reports nothing after it unmounts.
- `instructions` replaces the generic hint shown while the camera runs.

Each mount owns one camera session. Unmounting stops the camera at once, even
while the browser still asks for permission.

## Accessibility

The live preview is a labelled video without audio. A status line announces
"Starting camera…" and then the instructions. Scanning cannot be the only way
to continue: keep a text field or a link next to it, and move focus there after
`onError`. The scan frame does not animate under `prefers-reduced-motion`.

## Runtime

The scanner needs the browser, a secure context, and a camera. The scanning
engine ([qr-scanner](https://github.com/nimiq/qr-scanner)) loads only when a
scanner mounts. Decoded content and camera frames are never logged.

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
