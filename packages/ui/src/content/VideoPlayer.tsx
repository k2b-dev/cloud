/**
 * VideoPlayer — one video with the browser's own controls inside a frame whose
 * size never depends on the video. The frame fills the height its host gives
 * it, or keeps a ratio where the host leaves the height open. The picture fits
 * inside uncropped, so a portrait reel and a wide recording both show whole and
 * nothing moves while the video loads.
 */

import { batch, createEffect, createSignal, type JSX, Match, Switch } from "solid-js";
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
   * for one and continues at the same time, playing if it was. A renewed address that fails before it shows that point,
   * or within ten seconds after, shows the fallback, so a renewed address must stay valid for longer.
   */
  renew?: () => Promise<string>;
  /** Offered with the fallback when the browser cannot play the video, typically a download. */
  fallbackAction?: JSX.Element;
  /**
   * Shown in the frame instead of the video while set, for example the host's own error with a retry when it could not
   * fetch the address. The frame keeps its size.
   */
  error?: JSX.Element;
  /** Called when the player gives up on the video and shows its fallback. */
  onFallback?: () => void;
  class?: string;
};

/** How far the arrow keys move playback, in seconds. */
const SEEK_STEP = 5;

/**
 * How long a renewed address has to hold at the point where its predecessor failed before a failure there counts as
 * new. A video that cannot play at a point fails again within moments, also where the engine reads or decodes ahead of
 * playback; an expired address fails only after its lifetime, which for a signed URL is typically a minute or more.
 */
const RENEWED_GRACE_MS = 10_000;

/** How close to the point where a renewed address continues the video has to be to count as there, in seconds. */
const RESUME_TOLERANCE = 0.05;

/** Where focus goes when the fallback replaces the focused video. */
const FALLBACK_FOCUS = ".k2b-video-player__fallback :is(a[href], button:not(:disabled))";

export function VideoPlayer(props: VideoPlayerProps) {
  const messages = useUiMessages();
  const [source, setSource] = createSignal<string | null>(props.src);
  /** Where the address in `source` starts, in seconds: 0 from the beginning, otherwise where a renewal continues. */
  const [start, setStart] = createSignal(0);
  const [failed, setFailed] = createSignal(false);
  let frame: HTMLDivElement | undefined;
  let video: HTMLVideoElement | undefined;
  /**
   * The last renewal: where to continue once the renewed address has loaded, and since when it shows that point. Until
   * it has held there for a while, a failure means the video itself does not play, not that the address expired.
   */
  let renewal: { time: number; rate: number; playing: boolean; loaded: boolean; readyAt: number | null } | null = null;
  /** Playing as the viewer meant it; a failing source may stop without a pause event. */
  let playing = false;

  // A new address from the host is another video: start over without resuming. It counts as new against the address
  // the player started with, because the host may change it before this effect first runs, for example on mount.
  let hostSrc = props.src;
  createEffect(() => {
    const src = props.src;
    if (src === hostSrc) return;
    hostSrc = src;
    renewal = null;
    playing = false;
    batch(() => {
      setFailed(false);
      setStart(0);
      setSource(src);
    });
  });

  // A media fragment makes the engine start where a renewed address continues, so no seek of the player's own competes
  // with it: WebKit drops a seek that arrives while the fragment's is under way. It replaces a fragment the renewed
  // address brings, which would start the engine at another point. Safari on iOS shows no frame before playback without
  // a poster; a fragment just after the beginning makes it load and show the first one.
  const videoSource = () => {
    const src = source();
    if (!src) return undefined;
    if (start() > 0) return `${src.replace(/#.*$/, "")}#t=${start().toFixed(3)}`;
    return src.includes("#") || props.poster ? src : `${src}#t=0.001`;
  };

  const giveUp = () => {
    // The fallback replaces the video, so focus on the video would drop to the page; it moves into the fallback.
    const focused = video !== undefined && document.activeElement === video;
    setFailed(true);
    if (focused) (frame?.querySelector<HTMLElement>(FALLBACK_FOCUS) ?? frame)?.focus();
    props.onFallback?.();
  };

  const fail = async () => {
    const element = video;
    if (!element || failed()) return;
    const recent = renewal && (renewal.readyAt === null || performance.now() - renewal.readyAt < RENEWED_GRACE_MS);
    if (!props.renew || recent) return giveUp();
    const requested = props.src;
    const time = element.currentTime;
    renewal = { time, rate: element.playbackRate, playing, loaded: false, readyAt: null };
    try {
      const renewed = await props.renew();
      if (requested !== props.src) return;
      const before = videoSource();
      batch(() => {
        setStart(time);
        setSource(renewed);
      });
      if (videoSource() === before) element.load();
    } catch {
      if (requested === props.src) giveUp();
    }
  };

  const loaded = () => {
    const element = video;
    if (!element) return;
    // Sound in an empty frame: the browser cannot decode the picture, for example HEVC outside Safari. A fresh address
    // does not change that.
    if (element.videoWidth === 0 && element.videoHeight === 0) return giveUp();
    if (!renewal || renewal.loaded) return;
    renewal.loaded = true;
    // WebKit applies the fragment only once it has a frame, so it may still stand at the beginning here; the player
    // seeks to the same point, and the fragment's seek that follows lands there too.
    if (renewal.time > 0 && Math.abs(element.currentTime - renewal.time) > RESUME_TOLERANCE) element.currentTime = renewal.time;
    element.playbackRate = renewal.rate;
    if (renewal.playing) void element.play().catch(() => undefined);
  };

  /** The renewed address holds once the video shows the point where it continues. */
  const ready = (event: Event & { currentTarget: HTMLVideoElement }) => {
    const element = event.currentTarget;
    if (renewal?.loaded && renewal.readyAt === null && !element.seeking && element.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA)
      renewal.readyAt = performance.now();
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
      ref={frame}
      class={`k2b-video-player ${props.class ?? ""}`}
      data-state={failed() ? "failed" : undefined}
      tabIndex={failed() ? -1 : undefined}
      style={{ "aspect-ratio": String(props.ratio && props.ratio > 0 ? props.ratio : 16 / 9) }}
    >
      <Switch fallback={<Placeholder class="k2b-video-player__fallback" state="loading" />}>
        <Match when={props.error}>{(error) => <div class="k2b-video-player__fallback">{error()}</div>}</Match>
        <Match when={failed()}>
          <Placeholder
            class="k2b-video-player__fallback"
            state="error"
            icon="ti ti-video-off"
            title={messages().videoCannotPlay}
            description={messages().videoCannotPlayDescription}
            action={props.fallbackAction}
          />
        </Match>
        <Match when={source()}>
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
            onLoadedData={ready}
            onSeeked={ready}
            onCanPlay={ready}
            onError={() => void fail()}
          >
            {messages().videoUnsupported}
          </video>
        </Match>
      </Switch>
    </div>
  );
}

export default VideoPlayer;
