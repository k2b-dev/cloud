import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { apiClient } from "../api/client";
import type { FileEntry } from "../contracts";
import { fileIcon, previewKind } from "./file-preview";

/**
 * Filegate renders thumbnails on demand and answers 503 thumbnail_capacity beyond a handful of
 * parallel renders, so requests are queued here and retried with backoff instead of failing.
 */
const CONCURRENCY = 3;
const RETRY_DELAYS = [600, 1500, 3000];
let active = 0;
const waiting: Array<() => void> = [];
const acquire = (signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal.aborted) { reject(signal.reason); return; }
  const ready = () => { signal.removeEventListener("abort", cancel); resolve(); };
  const cancel = () => {
    const index = waiting.indexOf(ready);
    if (index >= 0) waiting.splice(index, 1);
    reject(signal.reason);
  };
  if (active < CONCURRENCY) { active++; resolve(); }
  else { waiting.push(ready); signal.addEventListener("abort", cancel, { once: true }); }
});
const release = () => {
  const next = waiting.shift();
  if (next) next();
  else active--;
};
const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal.aborted) { reject(signal.reason); return; }
  const cancel = () => { clearTimeout(timer); reject(signal.reason); };
  const timer = setTimeout(() => { signal.removeEventListener("abort", cancel); resolve(); }, ms);
  signal.addEventListener("abort", cancel, { once: true });
});
const loadImage = (url: string, signal: AbortSignal) => new Promise<string>((resolve, reject) => {
  if (signal.aborted) { reject(signal.reason); return; }
  const image = new Image();
  const cleanup = () => { signal.removeEventListener("abort", cancel); image.onload = null; image.onerror = null; };
  const cancel = () => { cleanup(); image.removeAttribute("src"); reject(signal.reason); };
  image.crossOrigin = "anonymous";
  image.referrerPolicy = "no-referrer";
  image.onload = () => { cleanup(); resolve(url); };
  image.onerror = () => { cleanup(); reject(new Error("thumbnail_unavailable")); };
  signal.addEventListener("abort", cancel, { once: true });
  image.src = url;
});

type ThumbnailProps = { baseId: string; locationKey?: string; entry: FileEntry; large?: boolean; hero?: boolean };
export default function FileThumbnail(props: ThumbnailProps) {
  return <Show keyed when={JSON.stringify([props.baseId, props.locationKey, props.entry.path, props.entry.modified, props.hero])}>
    {(_key) => <ThumbnailImage {...props} />}
  </Show>;
}
function ThumbnailImage(props: ThumbnailProps) {
  const [url, setUrl] = createSignal<string | null>(null);
  let host: HTMLSpanElement | undefined;
  const controller = new AbortController();
  onCleanup(() => controller.abort());
  const load = async () => {
    const signal = controller.signal;
    for (const [attempt, delay] of [0, ...RETRY_DELAYS].entries()) {
      if (delay) await sleep(delay, signal).catch(() => {});
      if (signal.aborted) return;
      try { await acquire(signal); } catch { return; }
      try {
        const response = await apiClient.bases[":baseId"].thumbnail.$post(
          { param: { baseId: props.baseId }, json: { path: props.entry.path, size: props.hero ? "large" : "small" } },
          { init: { signal } },
        );
        if (!response.ok) {
          if ((response.status as number) === 503 && attempt < RETRY_DELAYS.length) continue;
          return;
        }
        const lease = await response.json();
        const loaded = await loadImage(lease.url, signal);
        if (!signal.aborted) setUrl(loaded);
        return;
      } catch {
        if (signal.aborted || attempt === RETRY_DELAYS.length) return;
      } finally {
        release();
      }
    }
  };
  onMount(() => {
    const image = previewKind(props.entry) === "image";
    if (!host || !image) return;
    if (typeof IntersectionObserver === "undefined") {
      void load();
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          observer.disconnect();
          void load();
        }
      },
      { rootMargin: "120px" },
    );
    observer.observe(host);
    onCleanup(() => observer.disconnect());
  });
  return (
    <span
      ref={host}
      class={`filesv2-thumbnail ${props.large ? "filesv2-thumbnail--large" : ""} ${props.hero ? "filesv2-thumbnail--hero" : ""}`}
      aria-hidden="true"
    >
      <Show when={url()} fallback={<i class={fileIcon(props.entry)} />}>
        {(href) => <img src={href()} alt="" draggable={false} referrerPolicy="no-referrer" crossOrigin="anonymous" />}
      </Show>
    </span>
  );
}
