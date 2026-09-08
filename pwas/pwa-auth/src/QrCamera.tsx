import { timed } from "@k2b/stdlib/solid";
import { useLocale } from "@k2b/ui";
import type QrScanner from "qr-scanner";
import { createMemo, createSignal, onCleanup, onMount, Show } from "solid-js";
import { authMessages } from "./i18n";

/** Owns exactly one camera session. Decoded text is untrusted until the SDK parser accepts it. */
export function QrCamera(props: { onResult: (text: string) => boolean; onStop: () => void; onError: () => void }) {
  const locale = useLocale();
  const t = createMemo(() => authMessages.resolve([locale()]).t);
  const [starting, setStarting] = createSignal(true);
  const [invalid, setInvalid] = createSignal(false);
  let lastRejected: string | undefined;
  const resetRejected = timed.debounce(() => {
    lastRejected = undefined;
  }, 1000);
  const resetFeedback = timed.debounce(() => setInvalid(false), 1500);
  let video!: HTMLVideoElement;
  let scanner: QrScanner | undefined;
  let closed = false;
  const destroy = () => {
    closed = true;
    resetRejected.cancel();
    resetFeedback.cancel();
    // pause(true) stops existing tracks immediately; destroy also handles a still-pending permission request.
    void scanner?.pause(true);
    scanner?.destroy();
    scanner = undefined;
  };
  onMount(() => {
    const hidden = () => {
      if (document.visibilityState !== "visible") props.onStop();
    };
    const leaving = () => props.onStop();
    document.addEventListener("visibilitychange", hidden);
    window.addEventListener("pagehide", leaving);
    onCleanup(() => {
      destroy();
      document.removeEventListener("visibilitychange", hidden);
      window.removeEventListener("pagehide", leaving);
    });
    void (async () => {
      try {
        const { default: Scanner } = await import("qr-scanner");
        if (closed || document.visibilityState !== "visible") return;
        scanner = new Scanner(
          video,
          (result) => {
            if (closed) return;
            // Rearm only after a full second without a decoded QR, not between individual frames.
            resetRejected.debouncedFn();
            if (result.data === lastRejected) return;
            if (props.onResult(result.data)) {
              destroy();
              return;
            }
            lastRejected = result.data;
            setInvalid(true);
            resetFeedback.debouncedFn();
          },
          {
            preferredCamera: "environment",
            highlightScanRegion: true,
            // Empty frames are expected. Never log decoded content or frame data.
            onDecodeError: (error) => {
              if (closed || error === Scanner.NO_QR_CODE_FOUND) return;
              destroy();
              props.onError();
            },
          },
        );
        await scanner.start();
        if (!closed) setStarting(false);
      } catch {
        if (closed) return;
        destroy();
        props.onError();
      }
    })();
  });
  return (
    <div class="auth-camera">
      <div class="auth-camera-preview" classList={{ "auth-camera-preview--invalid": invalid() }}>
        {/* Live camera preview contains no prerecorded speech or audio. */}
        <video ref={video} muted playsinline aria-label={t().cameraPreview} />
      </div>
      <p role="status">{starting() ? t().cameraStarting : t().cameraInstructions}</p>
      <Show when={!starting()}>
        <p class="auth-flow-note">{t().cameraPrivacy}</p>
      </Show>
    </div>
  );
}
