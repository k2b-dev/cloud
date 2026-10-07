/**
 * VideoPlayer — one video with the browser's own controls inside a frame whose
 * size never depends on the video. The frame fills the height its host gives
 * it, or keeps a ratio where the host leaves the height open. The picture fits
 * inside uncropped, so a portrait reel and a wide recording both show whole and
 * nothing moves while the video loads.
 */

import { createEffect, createSignal, type JSX, on, Show } from "solid-js";
import { useUiMessages } from "../intl/messages";
import Placeholder from "../surfaces/Placeholder";

export type VideoPlayerProps = {
  /**
   * Inline address of the video. Seeking needs a server that answers `Range` requests; Safari plays nothing without.
   * Null while the host still fetches it, for example a signed URL: the frame already shows at its final size.
   */
  src: string | null;
  /** Names the video for assistive technology, for example its file name. */
  label: string;
  /** Picture shown before playback starts. Without one, the player shows the first frame. */
  poster?: string;
  /** Width divided by height of the frame where the host leaves its height open. Defaults to 16 / 9. */
  ratio?: number;
  /** CORS mode for a video on another origin. Omit to keep the browser default. */
  crossOrigin?: "anonymous" | "use-credentials";
  /**
   * Resolves a fresh address of the same video, for example a renewed signed URL. When playback fails, the player asks
   * for one and continues at the same time, playing if it was. A second failure at the same point shows the fallback.
   */
  renew?: () => Promise<string>;
  /** Offered with the fallback when the browser cannot play the video, typically a download. */
  fallbackAction?: JSX.Element;
  /** Called when the player gives up on the video and shows its fallback. */
  onFallback?: () => void;
  class?: string;
};

/** How far the arrow keys move playback, in seconds. */
const SEEK_STEP = 5;

/** Safari on iOS shows no frame before playback without a poster; a media fragment makes it load and show the first one. */
const withFirstFrame = (src: string) => (src.includes("#") ? src : `${src}#t=0.001`);

export function VideoPlayer(props: VideoPlayerProps) {
  const messages = useUiMessages();
  const [source, setSource] = createSignal<string | null>(props.src);
  const [failed, setFailed] = createSignal(false);
  let video: HTMLVideoElement | undefined;
  /** Where to continue once a renewed address has loaded. */
  let resume: { time: number; rate: number; playing: boolean } | null = null;
  /** Playing as the viewer meant it; a failing source may stop without a pause event. */
  let playing = false;
  /** Where playback last failed; failing there again means a renewed address does not help. */
  let failedAt: number | null = null;

  // A new address from the host is another video: start over without resuming.
  createEffect(
    on(
      () => props.src,
      (src) => {
        resume = null;
        failedAt = null;
        playing = false;
        setFailed(false);
        setSource(src);
      },
      { defer: true },
    ),
  );

  const videoSource = () => {
    const src = source();
    return src && !props.poster ? withFirstFrame(src) : (src ?? undefined);
  };

  const giveUp = () => {
    setFailed(true);
    props.onFallback?.();
  };

  const fail = async () => {
    const element = video;
    if (!element || failed()) return;
    const time = element.currentTime;
    // A renewed address that fails before it loads, or a failure at the same point again, is not an expired address.
    if (!props.renew || resume || (failedAt !== null && Math.abs(time - failedAt) < 0.5)) return giveUp();
    failedAt = time;
    const state = { time, rate: element.playbackRate, playing };
    const requested = props.src;
    try {
      const renewed = await props.renew();
      if (requested !== props.src) return;
      resume = state;
      if (renewed === source()) element.load();
      else setSource(renewed);
    } catch {
      if (requested === props.src) giveUp();
    }
  };

  const loaded = () => {
    const element = video;
    if (!element || !resume) return;
    const { time, rate, playing: wasPlaying } = resume;
    resume = null;
    if (time > 0) element.currentTime = time;
    element.playbackRate = rate;
    if (wasPlaying) void element.play().catch(() => undefined);
  };

  const fullscreen = (element: HTMLVideoElement) => {
    if (document.fullscreenElement) return void document.exitFullscreen().catch(() => undefined);
    if (element.requestFullscreen) return void element.requestFullscreen().catch(() => undefined);
    // Safari on iOS has no element fullscreen for video, only its own player.
    if ("webkitEnterFullscreen" in element && typeof element.webkitEnterFullscreen === "function") element.webkitEnterFullscreen();
  };

  const toggle = (element: HTMLVideoElement) => {
    if (element.paused) void element.play().catch(() => undefined);
    else element.pause();
  };

  /** Whether the video was paused when Space went down; null while no Space press is open. */
  let spacePaused: boolean | null = null;

  // Native controls differ per engine: WebKit has no keyboard playback at all, so the player gives every engine the
  // same keys. The keys reach the player only while the video itself has focus, not one of the browser's buttons.
  const onKeyDown = (event: KeyboardEvent & { currentTarget: HTMLVideoElement }) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const element = event.currentTarget;
    switch (event.key) {
      case " ":
        // Chromium toggles on release whatever the page does, so Space waits for it and toggles only if it did not.
        if (!event.repeat) spacePaused = element.paused;
        break;
      case "k":
        toggle(element);
        break;
      case "ArrowLeft":
        element.currentTime = Math.max(0, element.currentTime - SEEK_STEP);
        break;
      case "ArrowRight":
        element.currentTime = Number.isFinite(element.duration)
          ? Math.min(element.duration, element.currentTime + SEEK_STEP)
          : element.currentTime + SEEK_STEP;
        break;
      case "m":
        element.muted = !element.muted;
        break;
      case "f":
        fullscreen(element);
        break;
      default:
        return;
    }
    event.preventDefault();
  };
  const onKeyUp = (event: KeyboardEvent & { currentTarget: HTMLVideoElement }) => {
    if (event.key !== " " || spacePaused === null) return;
    const element = event.currentTarget;
    const paused = spacePaused;
    spacePaused = null;
    setTimeout(() => {
      if (element.paused === paused) toggle(element);
    });
  };

  return (
    <div
      class={`k2b-video-player ${props.class ?? ""}`}
      data-state={failed() ? "failed" : undefined}
      style={{ "aspect-ratio": String(props.ratio && props.ratio > 0 ? props.ratio : 16 / 9) }}
    >
      <Show
        when={!failed() && source()}
        fallback={
          <Show when={failed()} fallback={<Placeholder class="k2b-video-player__fallback" state="loading" />}>
            <Placeholder
              class="k2b-video-player__fallback"
              icon="ti ti-video-off"
              title={messages().videoCannotPlay}
              description={messages().videoCannotPlayDescription}
              action={props.fallbackAction}
            />
          </Show>
        }
      >
        <video
          ref={video}
          class="k2b-video-player__video"
          src={videoSource()}
          poster={props.poster}
          crossOrigin={props.crossOrigin}
          controls
          playsinline
          preload="metadata"
          tabIndex={0}
          aria-label={props.label}
          onKeyDown={onKeyDown}
          onKeyUp={onKeyUp}
          onPlay={() => {
            playing = true;
          }}
          onPause={(event) => {
            // A video that stops because its source failed has not been paused by the viewer.
            if (!event.currentTarget.error) playing = false;
          }}
          onEnded={() => {
            playing = false;
          }}
          onLoadedMetadata={loaded}
          onTimeUpdate={(event) => {
            // Played on past the failure: a later failure there is a new one.
            if (failedAt !== null && !event.currentTarget.paused && event.currentTarget.currentTime > failedAt + 1) failedAt = null;
          }}
          onError={() => void fail()}
        >
          {messages().videoUnsupported}
        </video>
      </Show>
    </div>
  );
}

export default VideoPlayer;
