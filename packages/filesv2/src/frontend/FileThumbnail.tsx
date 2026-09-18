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
const acquire = () =>
  new Promise<void>((resolve) => {
    if (active < CONCURRENCY) {
      active++;
      resolve();
    } else waiting.push(resolve);
  });
const release = () => {
  const next = waiting.shift();
  if (next) next();
  else active--;
};
const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason);
    });
  });
const loadImage = (url: string, signal: AbortSignal) =>
  new Promise<string>((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.referrerPolicy = "no-referrer";
    image.onload = () => resolve(url);
    image.onerror = () => reject(new Error("thumbnail_unavailable"));
    signal.addEventListener("abort", () => reject(signal.reason));
    image.src = url;
  });

export default function FileThumbnail(props: { baseId: string; entry: FileEntry; large?: boolean; hero?: boolean }) {
  const [url, setUrl] = createSignal<string | null>(null);
  let host: HTMLSpanElement | undefined;
  const controller = new AbortController();
  onCleanup(() => controller.abort());
  const load = async () => {
    const signal = controller.signal;
    for (const [attempt, delay] of [0, ...RETRY_DELAYS].entries()) {
      if (delay) await sleep(delay, signal).catch(() => {});
      if (signal.aborted) return;
      await acquire();
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
        setUrl(await loadImage(lease.url, signal));
        return;
      } catch {
        if (signal.aborted || attempt === RETRY_DELAYS.length) return;
      } finally {
        release();
      }
    }
  };
  onMount(() => {
    if (!host || previewKind(props.entry) !== "image") return;
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
