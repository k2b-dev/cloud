import { timed } from "@k2b/stdlib/solid";
import type QrScannerEngine from "qr-scanner";
import { createSignal, type JSX, onCleanup, onMount, Show } from "solid-js";
import { Button } from "../actions/Button";
import { useUiMessages } from "../intl/messages";
import { prefersReducedMotion } from "../motion";
import { useQrMessages } from "./qr-messages";

/**
 * Why the scanner could not start, as far as the browser tells: `"denied"` when camera access is off, `"no-camera"`
 * when the device has no camera, `"in-use"` when the camera is busy or could not start, most often because another app
 * holds it, and `"unavailable"` for anything else, including a scanning engine that cannot load.
 */
export type QrScannerError = "denied" | "no-camera" | "in-use" | "unavailable";

export type QrScannerProps = {
  /** Decoded text is untrusted. Return `true` to accept it and stop the camera, `false` to reject it and keep scanning. */
  onResult: (text: string) => boolean;
  /** The page was hidden or left; unmount the scanner. */
  onStop: () => void;
  /**
   * The camera or the scanning engine could not start; the scanner has stopped. Offer another way in. A frame that
   * cannot be decoded never ends here.
   */
  onError: (reason: QrScannerError) => void;
  /** What to point the camera at. Defaults to a generic QR code hint. */
  instructions?: string;
  class?: string;
};

const sizes: MediaTrackConstraints[] = [{ width: { min: 1024 } }, { width: { min: 768 } }, {}];
/** The rear camera at a resolution that keeps small codes readable, then any camera: the order qr-scanner tries. */
const cameraRequests: MediaTrackConstraints[] = [...sizes.map((size) => ({ ...size, facingMode: { exact: "environment" } })), ...sizes];

const errorName = (error: unknown): string => (typeof error === "object" && error !== null && "name" in error ? String(error.name) : "");

const cameraFailure = (name: string): QrScannerError => {
  if (name === "NotAllowedError" || name === "SecurityError") return "denied";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "no-camera";
  if (name === "NotReadableError") return "in-use";
  return "unavailable";
};

/** The facing a track reports, or else the one its label names, as qr-scanner reads it. */
const facingOf = (track: MediaStreamTrack | undefined): string | undefined => {
  if (!track) return undefined;
  const { facingMode } = track.getSettings();
  if (facingMode) return facingMode;
  if (/rear|back|environment/i.test(track.label)) return "environment";
  if (/front|user|face/i.test(track.label)) return "user";
  return undefined;
};

/**
 * Opens the camera here rather than in qr-scanner, which turns every failure into "Camera not found.". A refusal ends
 * the search, because asking again could show the permission prompt again. Any other failure may belong to the request,
 * such as a camera that cannot start at the larger size, so the next, looser request follows, as in qr-scanner. When
 * none succeeds, a camera that exists but fails outweighs a request no camera could meet. A closed scanner asks no more.
 */
const openCamera = async (closed: () => boolean): Promise<{ stream: MediaStream; mirrored: boolean } | { error: QrScannerError }> => {
  if (!navigator.mediaDevices) return { error: "unavailable" };
  let error: QrScannerError = "no-camera";
  for (const video of cameraRequests) {
    if (closed()) break;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
      const facing = facingOf(stream.getVideoTracks()[0]);
      // Like qr-scanner, mirror a front camera, and a camera of unknown facing that the rear request did not find.
      return { stream, mirrored: facing ? facing === "user" : !video.facingMode };
    } catch (failure) {
      const reason = cameraFailure(errorName(failure));
      if (reason === "denied") return { error: reason };
      if (reason !== "no-camera") error = reason;
    }
  }
  return { error };
};

/**
 * How long the camera may take to show its first picture. A working camera shows one well within a second; after three
 * the person has looked at a black square long enough to need a way to start it again.
 */
const firstPictureMs = 3000;

const stopStream = (stream: MediaStream) => {
  for (const track of stream.getTracks()) track.stop();
};

/**
 * Scans a QR code with the rear camera. Each mount owns exactly one camera session, which stops when the scanner
 * unmounts, the page is hidden, or a result is accepted. The scanning engine loads only when the scanner mounts.
 * Decoded content is never logged.
 */
export function QrScanner(props: QrScannerProps): JSX.Element {
  const qrMessages = useQrMessages();
  const uiMessages = useUiMessages();
  const [starting, setStarting] = createSignal(true);
  const [stalled, setStalled] = createSignal(false);
  const [invalid, setInvalid] = createSignal(false);
  let lastRejected: string | undefined;
  const resetRejected = timed.debounce(() => {
    lastRejected = undefined;
  }, 1000);
  const resetFeedback = timed.debounce(() => setInvalid(false), 1500);
  let video!: HTMLVideoElement;
  let scanner: QrScannerEngine | undefined;
  let stream: MediaStream | undefined;
  let closed = false;
  const detach: (() => void)[] = [];
  const destroy = () => {
    closed = true;
    for (const listener of detach.splice(0)) listener();
    resetRejected.cancel();
    resetFeedback.cancel();
    // pause(true) stops the camera stream immediately while the engine runs; a stream it never started stops here.
    void scanner?.pause(true);
    scanner?.destroy();
    scanner = undefined;
    if (stream) stopStream(stream);
    stream = undefined;
    video.srcObject = null;
  };
  // Once closed, the host has unmounted the scanner or heard why it stopped; later failures stay silent.
  const fail = (reason: QrScannerError) => {
    if (closed) return;
    destroy();
    props.onError(reason);
  };
  /**
   * Waits for the camera picture. WebKit, above all in an installed web app, can leave a stream black: play() never
   * settles or is refused. The scanner then offers to try again rather than wait in silence, and a picture that starts
   * late still clears that offer.
   */
  let attempt = 0;
  const show = async (play: () => Promise<void>) => {
    const current = ++attempt;
    const latest = () => !closed && current === attempt;
    setStalled(false);
    const playing = play().then(
      () => video.videoWidth > 0,
      () => false,
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const shown = await Promise.race([
      playing,
      new Promise<false>((resolve) => {
        timer = setTimeout(resolve, firstPictureMs, false);
      }),
    ]);
    clearTimeout(timer);
    if (!latest()) return;
    if (!shown) {
      setStalled(true);
      if (!(await playing) || !latest()) return;
    }
    setStalled(false);
    setStarting(false);
  };
  /**
   * Attaching the stream again restarts a player that stalled on it, and play() runs within the click, the gesture a
   * refused play() may need. The engine already runs from its first start and scans from the play event it hears.
   */
  const retry = () => {
    if (closed || !stream) return;
    video.srcObject = null;
    video.srcObject = stream;
    void show(() => video.play());
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
            highlightScanRegion: true,
            // A frame that cannot be decoded never ends the session: the camera runs, and the next frame may read.
            // An engine error other than an empty frame, which the native BarcodeDetector reports as "Scanner error:
            // No QR code found", means the detector cannot read on this device. Fall back to the bundled worker for
            // the page through the flag qr-scanner 1.4.2 sets itself for "not implemented" and "service unavailable";
            // it swaps engines after this frame. Worker errors carry the same prefix; the flag changes nothing there.
            // qr-scanner reports frames only as strings: an Error means the engine itself did not load, such as a
            // decoder chunk gone after a deploy or a worker that cannot start, and no later frame can read. Never log
            // decoded content or frame data.
            onDecodeError: (error) => {
              if (typeof error !== "string") return fail("unavailable");
              if (error.startsWith("Scanner error: ") && !error.endsWith(Engine.NO_QR_CODE_FOUND)) {
                Reflect.set(Engine, "_disableBarcodeDetector", true);
              }
            },
          },
        );
        const motion = matchMedia("(prefers-reduced-motion: reduce)");
        const applyMotion = () => {
          for (const animation of scanner?.$overlay?.getAnimations({ subtree: true }) ?? []) {
            if (prefersReducedMotion()) animation.pause();
            else animation.play();
          }
        };
        applyMotion();
        motion.addEventListener("change", applyMotion);
        detach.push(() => motion.removeEventListener("change", applyMotion));
        // The engine places its scan region and frame on loadedmetadata, play, and a window resize. It misses a picture
        // that turns, as when a tablet rotates, and a preview that changes size alone; replay loadedmetadata for both,
        // or the region stays where the old picture had it and the frame sits off-centre.
        const relayout = () => {
          if (video.videoWidth > 0) video.dispatchEvent(new Event("loadedmetadata"));
        };
        video.addEventListener("resize", relayout);
        const resized = new ResizeObserver(relayout);
        resized.observe(video);
        detach.push(() => {
          video.removeEventListener("resize", relayout);
          resized.disconnect();
        });
        const camera = await openCamera(() => closed);
        if ("error" in camera) return fail(camera.error);
        if (closed) return stopStream(camera.stream);
        // qr-scanner plays a stream that is already set instead of opening its own.
        stream = camera.stream;
        video.srcObject = stream;
        video.style.transform = camera.mirrored ? "scaleX(-1)" : "";
        // start() awaits the engine's play() of this stream.
        const engine = scanner;
        await show(() => engine.start());
      } catch {
        fail("unavailable");
      }
    })();
  });
  return (
    <div class={props.class ? `k2b-qr-scanner ${props.class}` : "k2b-qr-scanner"}>
      <div class="k2b-qr-scanner__preview" data-invalid={invalid() || undefined}>
        {/* Live camera preview contains no prerecorded speech or audio. */}
        <video ref={video} autoplay muted playsinline aria-label={qrMessages().qrCameraPreview} />
      </div>
      <p role="status">
        {stalled()
          ? qrMessages().qrCameraStalled
          : starting()
            ? qrMessages().qrCameraStarting
            : (props.instructions ?? qrMessages().qrCameraInstructions)}
      </p>
      <Show when={stalled()}>
        <Button type="button" size="sm" variant="secondary" class="k2b-qr-scanner__retry" onClick={retry}>
          {uiMessages().tryAgain}
        </Button>
      </Show>
      <Show when={!starting()}>
        <p class="k2b-qr-scanner__note">{qrMessages().qrCameraPrivacy}</p>
      </Show>
    </div>
  );
}

export default QrScanner;
