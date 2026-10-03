import { timed } from "@k2b/stdlib/solid";
import type QrScannerEngine from "qr-scanner";
import { createSignal, type JSX, onCleanup, onMount, Show } from "solid-js";
import { useUiMessages } from "../intl/messages";

export type QrScannerError = "denied" | "unavailable";

export type QrScannerProps = {
  /** Decoded text is untrusted. Return `true` to accept it and stop the camera, `false` to reject it and keep scanning. */
  onResult: (text: string) => boolean;
  /** The page was hidden or left; unmount the scanner. */
  onStop: () => void;
  /** The camera could not start: access was denied, or there is no usable camera. Offer another way in. */
  onError: (reason: QrScannerError) => void;
  /** What to point the camera at. Defaults to a generic QR code hint. */
  instructions?: string;
  class?: string;
};

/**
 * qr-scanner turns every getUserMedia failure into the string "Camera not found.", so only the Permissions API can
 * tell a refusal apart. Safari and Chrome expose the camera permission; elsewhere a refusal counts as unavailable.
 */
const cameraDenied = async (): Promise<boolean> => {
  try {
    return (await navigator.permissions.query({ name: "camera" as PermissionName })).state === "denied";
  } catch {
    return false;
  }
};

/**
 * Scans a QR code with the rear camera. Each mount owns exactly one camera session, which stops when the scanner
 * unmounts, the page is hidden, or a result is accepted. The scanning engine loads only when the scanner mounts.
 * Decoded content is never logged.
 */
export function QrScanner(props: QrScannerProps): JSX.Element {
  const messages = useUiMessages();
  const [starting, setStarting] = createSignal(true);
  const [invalid, setInvalid] = createSignal(false);
  let lastRejected: string | undefined;
  const resetRejected = timed.debounce(() => {
    lastRejected = undefined;
  }, 1000);
  const resetFeedback = timed.debounce(() => setInvalid(false), 1500);
  let video!: HTMLVideoElement;
  let scanner: QrScannerEngine | undefined;
  let closed = false;
  /** The host has unmounted the scanner; it no longer hears about failures that finish later. */
  let unmounted = false;
  let cleanupMotion: (() => void) | undefined;
  const destroy = () => {
    closed = true;
    cleanupMotion?.();
    resetRejected.cancel();
    resetFeedback.cancel();
    // pause(true) stops existing tracks immediately; destroy also handles a still-pending permission request.
    void scanner?.pause(true);
    scanner?.destroy();
    scanner = undefined;
  };
  const fail = async () => {
    if (closed) return;
    destroy();
    const denied = await cameraDenied();
    if (!unmounted) props.onError(denied ? "denied" : "unavailable");
  };
  onMount(() => {
    const hidden = () => {
      if (document.visibilityState !== "visible") props.onStop();
    };
    const leaving = () => props.onStop();
    document.addEventListener("visibilitychange", hidden);
    window.addEventListener("pagehide", leaving);
    onCleanup(() => {
      unmounted = true;
      destroy();
      document.removeEventListener("visibilitychange", hidden);
      window.removeEventListener("pagehide", leaving);
    });
    void (async () => {
      try {
        const { default: Engine } = await import("qr-scanner");
        if (closed || document.visibilityState !== "visible") return;
        scanner = new Engine(
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
              if (closed || error === Engine.NO_QR_CODE_FOUND) return;
              void fail();
            },
          },
        );
        const motion = matchMedia("(prefers-reduced-motion: reduce)");
        const applyMotion = () => {
          for (const animation of scanner?.$overlay?.getAnimations({ subtree: true }) ?? []) {
            if (motion.matches) animation.pause();
            else animation.play();
          }
        };
        applyMotion();
        motion.addEventListener("change", applyMotion);
        cleanupMotion = () => motion.removeEventListener("change", applyMotion);
        await scanner.start();
        if (!closed) setStarting(false);
      } catch {
        await fail();
      }
    })();
  });
  return (
    <div class={props.class ? `k2b-qr-scanner ${props.class}` : "k2b-qr-scanner"}>
      <div class="k2b-qr-scanner__preview" data-invalid={invalid() || undefined}>
        {/* Live camera preview contains no prerecorded speech or audio. */}
        <video ref={video} muted playsinline aria-label={messages().qrCameraPreview} />
      </div>
      <p role="status">{starting() ? messages().qrCameraStarting : (props.instructions ?? messages().qrCameraInstructions)}</p>
      <Show when={!starting()}>
        <p class="k2b-qr-scanner__note">{messages().qrCameraPrivacy}</p>
      </Show>
    </div>
  );
}

export default QrScanner;
